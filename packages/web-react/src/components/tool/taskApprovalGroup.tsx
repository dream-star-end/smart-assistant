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
import { type ChatInteraction, useChatInteraction, useToolCardActions } from "./context";
export {
  coalesceTaskApprovalGroups,
  extractTaskApprovalTicketId,
  isTaskApprovalToolMessage,
} from "./taskApprovalCoalesce";

type SummarySendStatus = "idle" | "sending" | "sent" | "failed";

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

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

function selectApprovableEntries(snap: TaskApprovalGroupSnapshot | null): TaskApprovalGroupEntry[] {
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
}

function resolveFooterHint(params: {
  sendingSummary: boolean;
  autoSendFailed: boolean;
  readyForAutoSend: boolean;
  chatBusy: boolean;
  batchApproving: boolean;
  hasSendUserText: boolean;
  decidedCount: number;
  allHandled: boolean;
  remaining: number;
}): string {
  const {
    sendingSummary,
    autoSendFailed,
    readyForAutoSend,
    chatBusy,
    batchApproving,
    hasSendUserText,
    decidedCount,
    allHandled,
    remaining,
  } = params;
  if (sendingSummary) return "正在发送审批结果…";
  if (autoSendFailed) return "发送失败，请点击重试（单据已生效）";
  if (readyForAutoSend && chatBusy) return "全部审批已生效，待当前回合结束后自动发给助手";
  if (chatBusy) return "等待当前回合结束后可操作";
  if (batchApproving) return "正在逐项提交审批…";
  if (!hasSendUserText) return "单据已实时生效，请手动回复助手继续";
  if (decidedCount === 0) return "单张审批实时生效，批完后一起发给助手";
  if (allHandled) return "全部已处理，可一次性发给助手";
  return `还有 ${remaining} 项未处理，现在也可先发送`;
}

function formatApproveAllLabel(approvableEntries: readonly TaskApprovalGroupEntry[]): string {
  const allBacklog = approvableEntries.length > 0 && approvableEntries.every((e) => e.ticketStatus === "backlog");
  if (approvableEntries.length === 1) return allBacklog ? "批准剩余 1 项" : "通过剩余 1 项";
  return allBacklog ? `全部批准（${approvableEntries.length}）` : `全部通过（${approvableEntries.length}）`;
}

function isGroupReadyForAutoSend(params: {
  snap: TaskApprovalGroupSnapshot;
  allHandled: boolean;
  noteOpen: boolean;
  groupNote: string;
  batchError: string | null;
  sendStatus: SummarySendStatus;
  hasSendUserText: boolean;
}): boolean {
  const { snap, allHandled, noteOpen, groupNote, batchError, sendStatus, hasSendUserText } = params;
  if (!allHandled || snap.decidedCount < 1 || !hasSendUserText) return false;
  if (snap.anyLoading || snap.anyDeciding || snap.batchApproving || snap.sent) return false;
  if (noteOpen || groupNote.trim() || batchError) return false;
  return sendStatus === "idle";
}

function buildFooterDisplayState(params: {
  snap: TaskApprovalGroupSnapshot;
  approvableEntries: readonly TaskApprovalGroupEntry[];
  chatBusy: boolean;
  hasSendUserText: boolean;
  noteOpen: boolean;
  groupNote: string;
  batchError: string | null;
  sendStatus: SummarySendStatus;
}) {
  const { snap, approvableEntries, chatBusy, hasSendUserText, noteOpen, groupNote, batchError, sendStatus } = params;
  const sendingSummary = sendStatus === "sending";
  const autoSendFailed = sendStatus === "failed";
  const busy = chatBusy || snap.batchApproving || snap.anyDeciding || sendingSummary;
  const canSend = hasSendUserText && snap.decidedCount >= 1 && !busy;
  const remaining = Math.max(0, snap.totalCount - snap.handledCount);
  const allHandled = remaining === 0 && snap.handledCount > 0 && !snap.anyLoading && snap.approvableCount === 0;
  const readyForAutoSend = isGroupReadyForAutoSend({
    snap, allHandled, noteOpen, groupNote, batchError, sendStatus, hasSendUserText,
  });
  const hint = resolveFooterHint({
    sendingSummary,
    autoSendFailed,
    readyForAutoSend,
    chatBusy,
    batchApproving: snap.batchApproving,
    hasSendUserText,
    decidedCount: snap.decidedCount,
    allHandled,
    remaining,
  });
  const approveAllLabel = formatApproveAllLabel(approvableEntries);

  return { busy, canSend, allHandled, readyForAutoSend, sendingSummary, hint, approveAllLabel };
}

type FooterDisplayState = ReturnType<typeof buildFooterDisplayState>;

function summaryFailMessage(auto: boolean, unaccepted: boolean): string {
  if (auto) {
    return unaccepted
      ? "全部审批已生效，但自动通知助手未受理，请点击「重试发送审批结果」。"
      : "全部审批已生效，但自动通知助手失败，请点击「重试发送审批结果」。";
  }
  return unaccepted
    ? "发送审批结果未受理，请点击「重试发送审批结果」。"
    : "发送审批结果失败，请点击「重试发送审批结果」。";
}

function useTaskApprovalSummaryDelivery(params: {
  store: TaskApprovalGroupStore | null;
  sendUserText?: ChatInteraction["sendUserText"];
}) {
  const { store, sendUserText } = params;
  const [sendStatus, setSendStatus] = useState<SummarySendStatus>("idle");
  const [sendError, setSendError] = useState<string | null>(null);
  const inFlightRef = useRef(false);
  const mountedRef = useRef(true);
  const storeRef = useRef(store);
  const sendUserTextRef = useRef(sendUserText);

  storeRef.current = store;
  sendUserTextRef.current = sendUserText;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const deliverSummary = useCallback(async (text: string, opts: { auto: boolean }): Promise<boolean> => {
    const targetStore = storeRef.current;
    const sender = sendUserTextRef.current;
    if (!targetStore || !sender || inFlightRef.current) return false;
    const current = targetStore.getSnapshot();
    if (current.sent || current.decidedCount < 1 || current.batchApproving || current.anyDeciding) return false;

    const isStillCurrent = () =>
      mountedRef.current && storeRef.current === targetStore && !targetStore.getSnapshot().sent;
    const failWith = (unaccepted: boolean) => {
      if (!isStillCurrent()) return false;
      setSendStatus("failed");
      setSendError(summaryFailMessage(opts.auto, unaccepted));
      return false;
    };
    const settle = (accepted: unknown): boolean => {
      if (!isStillCurrent()) return false;
      if (accepted === false) return failWith(true);
      targetStore.markSent();
      setSendStatus("sent");
      setSendError(null);
      return true;
    };

    inFlightRef.current = true;
    setSendError(null);
    try {
      const result = sender(text);
      if (isPromiseLike(result)) {
        setSendStatus("sending");
        try {
          return settle(await result);
        } catch {
          return failWith(false);
        } finally {
          inFlightRef.current = false;
        }
      }
      inFlightRef.current = false;
      return settle(result);
    } catch {
      inFlightRef.current = false;
      return failWith(false);
    }
  }, []);

  return { sendStatus, sendError, deliverSummary };
}

function resolveBatchErrorFromFailedKeys(
  snap: TaskApprovalGroupSnapshot | null,
  failedBatchKeys: readonly string[],
): string | null {
  if (!snap || failedBatchKeys.length === 0) return null;
  const settled = new Set<string>();
  for (const e of snap.entries) {
    if (e.decision || e.alreadySettledExternally) {
      settled.add(normalizeTicketKey(e.identifier || e.ticketId));
    }
  }
  const unresolved = failedBatchKeys.filter((k) => !settled.has(k));
  return unresolved.length > 0 ? `有 ${unresolved.length} 项审批未成功，请查看上方对应卡片重试。` : null;
}

function useTaskApprovalBatchApprove(params: {
  store: TaskApprovalGroupStore | null;
  approvableEntries: readonly TaskApprovalGroupEntry[];
  chatBusy: boolean;
  setFailedBatchKeys: (keys: string[]) => void;
}) {
  const { store, approvableEntries, chatBusy, setFailedBatchKeys } = params;
  const mountedRef = useRef(true);
  const chatBusyRef = useRef(chatBusy);
  chatBusyRef.current = chatBusy;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  return useCallback(async () => {
    if (!store || approvableEntries.length === 0 || chatBusyRef.current) return;
    setFailedBatchKeys([]);
    store.setBatchApproving(true);
    const failedKeys: string[] = [];
    try {
      for (const entry of approvableEntries) {
        if (!entry.triggerApprove) continue;
        const normKey = normalizeTicketKey(entry.identifier || entry.ticketId);
        try {
          if (!(await entry.triggerApprove())) failedKeys.push(normKey);
        } catch {
          failedKeys.push(normKey);
        }
      }
    } finally {
      store.setBatchApproving(false);
    }
    if (mountedRef.current && failedKeys.length > 0) {
      setFailedBatchKeys(failedKeys);
    }
  }, [store, approvableEntries, setFailedBatchKeys]);
}

function TaskApprovalGroupSentNotice({ snap }: { snap: TaskApprovalGroupSnapshot }) {
  const unhandled = Math.max(0, snap.totalCount - snap.handledCount);
  return (
    <p data-testid="task-approval-group-sent" className="flex items-center gap-1.5 px-1 text-caption text-faint">
      <ClipboardCheck className="size-3.5 text-success" strokeWidth={1.75} />
      {unhandled > 0 ? `已汇总发送审批结果（另有 ${unhandled} 项标为暂未处理）。` : "已汇总发送全部审批结果。"}
    </p>
  );
}

function TaskApprovalGroupFooterCard(props: {
  snap: TaskApprovalGroupSnapshot;
  display: FooterDisplayState;
  approvableCount: number;
  sendStatus: SummarySendStatus;
  hasSendUserText: boolean;
  chatBusy: boolean;
  noteOpen: boolean;
  groupNote: string;
  errorMessage: string | null;
  onApproveAll: () => void;
  onToggleNote: () => void;
  onNoteChange: (val: string) => void;
  onSendSummary: () => void;
}) {
  const {
    snap, display, approvableCount, sendStatus, hasSendUserText, chatBusy, noteOpen, groupNote,
    errorMessage, onApproveAll, onToggleNote, onNoteChange, onSendSummary,
  } = props;
  const { busy, canSend, allHandled, sendingSummary, hint, approveAllLabel } = display;
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
          项{hint ? <span className="text-faint"> · {hint}</span> : null}
        </output>
        <div className="flex flex-wrap items-center gap-2">
          {approvableCount >= 1 ? (
            <Button
              type="button" variant="secondary" size="sm" data-testid="task-approval-approve-all"
              disabled={busy} loading={snap.batchApproving} onClick={onApproveAll}
            >
              <CheckCheck className="size-3.5" strokeWidth={1.75} />
              {approveAllLabel}
            </Button>
          ) : null}
          {hasSendUserText ? (
            <>
              <button
                type="button" aria-expanded={noteOpen} disabled={busy} onClick={onToggleNote}
                className="oc-btn-tactile rounded-md px-2 py-1 text-caption font-medium text-muted transition-colors hover:bg-hover hover:text-fg disabled:opacity-40 [@media(hover:none)]:min-h-11"
              >
                {noteOpen ? "收起补充说明" : "补充说明"}
              </button>
              <Button
                type="button" variant={allHandled ? "accent" : "primary"} size="sm"
                data-testid="task-approval-send-summary" disabled={!canSend} loading={sendingSummary}
                title={chatBusy ? "等待当前回合结束后可发送" : undefined} onClick={onSendSummary}
              >
                <Send className="size-3.5" strokeWidth={1.75} />
                {sendStatus === "failed" ? "重试发送审批结果" : "发送审批结果"}
              </Button>
            </>
          ) : null}
        </div>
      </div>
      {errorMessage ? (
        <p className="oc-callout oc-callout-danger rounded-md px-2.5 py-1.5 text-caption text-danger">{errorMessage}</p>
      ) : null}
      {noteOpen && hasSendUserText ? (
        <input
          type="text" aria-label="审批补充说明" data-testid="task-approval-group-note-input"
          value={groupNote} disabled={busy} onChange={(e) => onNoteChange(e.target.value)}
          placeholder="选填：输入统一要求或优先级，随审批结果一并发出"
          className="oc-surface-recessed w-full rounded-lg border border-border-control/70 bg-elevated px-3 py-1.5 text-base text-fg outline-none transition-[border-color,box-shadow] focus:border-accent focus-visible:ring-2 focus-visible:ring-ring md:text-meta"
        />
      ) : null}
    </div>
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
  const [failedBatchKeys, setFailedBatchKeys] = useState<string[]>([]);

  const approvableEntries = useMemo(() => selectApprovableEntries(snap), [snap]);
  const summaryText = useMemo(() => (snap ? formatTaskApprovalSummary(snap.entries, groupNote) : ""), [snap, groupNote]);
  const batchError = useMemo(() => resolveBatchErrorFromFailedKeys(snap, failedBatchKeys), [snap, failedBatchKeys]);
  const { sendStatus, sendError, deliverSummary } = useTaskApprovalSummaryDelivery({ store, sendUserText });
  const handleApproveAll = useTaskApprovalBatchApprove({ store, approvableEntries, chatBusy: Boolean(chatBusy), setFailedBatchKeys });

  const display = snap
    ? buildFooterDisplayState({
        snap, approvableEntries, chatBusy: Boolean(chatBusy), hasSendUserText: Boolean(sendUserText),
        noteOpen, groupNote, batchError, sendStatus,
      })
    : null;
  const readyForAutoSend = Boolean(store && snap?.grouped && taskApproval && display?.readyForAutoSend);

  useEffect(() => {
    if (!readyForAutoSend || chatBusy) return;
    void deliverSummary(summaryText, { auto: true });
  }, [readyForAutoSend, chatBusy, deliverSummary, summaryText]);

  const handleSendSummary = useCallback(() => {
    if (!store || !sendUserText || !snap || snap.decidedCount < 1 || snap.batchApproving || chatBusy) return;
    setFailedBatchKeys([]);
    void deliverSummary(summaryText, { auto: false });
  }, [store, sendUserText, snap, chatBusy, deliverSummary, summaryText]);

  if (!store || !snap || !snap.grouped || !taskApproval || !display) return null;
  if (!(snap.anyLoading || snap.approvableCount > 0 || snap.decidedCount > 0 || snap.sent)) return null;
  if (snap.sent) return <TaskApprovalGroupSentNotice snap={snap} />;

  return (
    <TaskApprovalGroupFooterCard
      snap={snap} display={display} approvableCount={approvableEntries.length} sendStatus={sendStatus}
      hasSendUserText={Boolean(sendUserText)} chatBusy={Boolean(chatBusy)} noteOpen={noteOpen} groupNote={groupNote}
      errorMessage={batchError ?? sendError} onApproveAll={() => void handleApproveAll()}
      onToggleNote={() => setNoteOpen((v) => !v)} onNoteChange={setGroupNote} onSendSummary={handleSendSummary}
    />
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
