/**
 * 对话内任务单人工审批卡。展示与操作一律以用户浏览器身份 GET/POST /api/board
 * 为准;agent 工具参数只提供 id / 可选提问,不能伪造单据状态。
 */
import { ClipboardCheck, AlertTriangle, ChevronDown, RotateCcw } from "lucide-react";
import { useCallback, useEffect, useId, useLayoutEffect, useState } from "react";
import { ApiError } from "../../lib/api";
import { recordTicketApprovalPending, syncTicketApprovalFromTicket } from "../../lib/sessionStatus";
import {
  TICKET_STATUS_LABEL,
  TICKET_TYPE_LABEL,
  isVersionConflict,
  taskboardErrorMessage,
  type Ticket,
  type TicketStatus,
  type TicketType,
} from "../../lib/taskboard";
import { cn } from "../../lib/utils";
import { Markdown } from "../Markdown";
import { Badge, Button, Spinner, Textarea } from "../ui";
import { useChatInteraction, useToolCardActions } from "./context";
import {
  useTaskApprovalGroup,
  useTaskApprovalGroupSnapshot,
  type TaskApprovalDecisionKind,
} from "./taskApprovalGroup";

function statusTone(status: TicketStatus): "warning" | "accent" | "success" | "neutral" | "danger" {
  if (status === "waiting_human" || status === "backlog") return "warning";
  if (status === "ready" || status === "running") return "accent";
  if (status === "done") return "success";
  if (status === "canceled" || status === "blocked") return "danger";
  return "neutral";
}

function isApprovable(status: TicketStatus): boolean {
  return status === "backlog" || status === "waiting_human";
}

export function TaskApprovalCard({ id, prompt }: { id: string; prompt?: string }) {
  const { taskApproval, onOpenTaskboard } = useToolCardActions();
  const { sendUserText, busy: chatBusy } = useChatInteraction();
  const approvalGroup = useTaskApprovalGroup();
  const groupSnap = useTaskApprovalGroupSnapshot();
  const cardKey = useId();
  const [ticket, setTicket] = useState<Ticket | null>(null);
  const [loading, setLoading] = useState(() => !!taskApproval);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  const [bodyExpanded, setBodyExpanded] = useState(false);
  const [deciding, setDeciding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  const [settled, setSettled] = useState<TaskApprovalDecisionKind | null>(null);
  const [manualFollowUp, setManualFollowUp] = useState<string | null>(null);

  useLayoutEffect(() => {
    if (!approvalGroup || !id) return;
    approvalGroup.registerCard(cardKey, id);
    return () => approvalGroup.detachCard(cardKey);
  }, [approvalGroup, cardKey, id]);

  useEffect(() => {
    if (!taskApproval || !id) return;
    let alive = true;
    setLoading(true);
    setLoadError(null);
    taskApproval
      .getTicket(id)
      .then((t) => {
        syncTicketApprovalFromTicket(t);
        if (id !== t.identifier && id !== t.id) recordTicketApprovalPending(id, isApprovable(t.status), t.version);
        if (alive) setTicket(t);
      })
      .catch((e) => {
        if (alive) {
          setLoadError(
            e instanceof ApiError ? taskboardErrorMessage(e, "加载任务单失败") : "加载任务单失败，请重试",
          );
        }
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [taskApproval, id, reloadTick]);

  const announce = useCallback(
    (kind: TaskApprovalDecisionKind, message: string) => {
      if (approvalGroup?.isActiveGrouped()) {
        approvalGroup.recordDecision(cardKey, { kind, summary: message });
        setManualFollowUp(null);
        return;
      }
      if (sendUserText) {
        sendUserText(message);
        setManualFollowUp(null);
      } else {
        setManualFollowUp("请回复助手继续。");
      }
    },
    [approvalGroup, cardKey, sendUserText],
  );

  const runWithRetry = useCallback(
    async (act: (t: Ticket) => Promise<{ ticket: Ticket }>): Promise<Ticket | null> => {
      if (!taskApproval || !ticket) return null;
      try {
        const out = await act(ticket);
        return out.ticket;
      } catch (e) {
        if (!isVersionConflict(e)) throw e;
        const fresh = await taskApproval.getTicket(id);
        setTicket(fresh);
        const out = await act(fresh);
        return out.ticket;
      }
    },
    [taskApproval, ticket, id],
  );

  const approveTicket = useCallback(async (): Promise<boolean> => {
    if (!taskApproval || !ticket || deciding) return false;
    setDeciding(true);
    setError(null);
    try {
      const next = await runWithRetry((t) => taskApproval.approve(t.identifier, t.version));
      if (!next) return false;
      syncTicketApprovalFromTicket(next);
      recordTicketApprovalPending(next.identifier, false, next.version);
      recordTicketApprovalPending(next.id, false, next.version);
      if (id !== next.identifier) recordTicketApprovalPending(id, false, next.version);
      setTicket(next);
      setSettled("approve");
      setDeciding(false);
      const ident = next.identifier;
      announce(
        "approve",
        next.status === "ready" && ticket.status === "backlog" ? `已批准开工 ${ident}` : `已通过 ${ident}`,
      );
      return true;
    } catch (e) {
      setError(e instanceof ApiError ? taskboardErrorMessage(e, "更新单据失败") : "更新单据失败，请重试");
      void taskApproval
        .getTicket(id)
        .then((t) => setTicket(t))
        .catch(() => {
          /* 刷新失败时保留本地错误 */
        });
      return false;
    } finally {
      setDeciding(false);
    }
  }, [taskApproval, ticket, deciding, runWithRetry, announce, id]);

  const onApprove = useCallback(() => {
    void approveTicket();
  }, [approveTicket]);

  const onReject = useCallback(() => {
    const reason = rejectReason.trim();
    if (!taskApproval || !ticket || deciding || !reason) return;
    setDeciding(true);
    setError(null);
    void runWithRetry((t) => taskApproval.reject(t.identifier, t.version, reason))
      .then((next) => {
        if (!next) return;
        syncTicketApprovalFromTicket(next);
        recordTicketApprovalPending(next.identifier, false, next.version);
        recordTicketApprovalPending(next.id, false, next.version);
        if (id !== next.identifier) recordTicketApprovalPending(id, false, next.version);
        setTicket(next);
        setSettled("reject");
        setRejectOpen(false);
        setDeciding(false);
        announce("reject", `已打回 ${next.identifier}：${reason}`);
      })
      .catch((e) => {
        setError(e instanceof ApiError ? taskboardErrorMessage(e, "打回失败") : "打回失败，请重试");
      })
      .finally(() => setDeciding(false));
  }, [taskApproval, ticket, deciding, rejectReason, runWithRetry, announce, id]);

  const onDefer = useCallback(() => {
    if (deciding || settled) return;
    recordTicketApprovalPending(ticket?.identifier ?? id, false);
    if (ticket?.identifier && id !== ticket.identifier) recordTicketApprovalPending(id, false);
    setSettled("defer");
    announce("defer", `暂不批准 ${ticket?.identifier ?? id}`);
  }, [announce, deciding, settled, ticket, id]);

  const status = ticket?.status;
  const approvable = !!status && isApprovable(status) && settled === null;
  const alreadySettledExternally = !!status && !isApprovable(status) && settled === null;
  const awaitingGroupSend = !!groupSnap && groupSnap.grouped && !groupSnap.sent;
  const batchApproving = groupSnap?.batchApproving === true;

  useEffect(() => {
    if (!approvalGroup || !id) return;
    approvalGroup.updateCard(cardKey, {
      identifier: ticket?.identifier ?? id,
      loading,
      approvable: !!taskApproval && !loading && !loadError && approvable,
      ticketStatus: status,
      ticketStatusLabel: status ? TICKET_STATUS_LABEL[status] : undefined,
      deciding: deciding && settled === null,
      alreadySettledExternally,
      triggerApprove: approvable ? approveTicket : undefined,
    });
  }, [
    approvalGroup,
    cardKey,
    id,
    ticket?.identifier,
    loading,
    loadError,
    taskApproval,
    approvable,
    status,
    deciding,
    alreadySettledExternally,
    approveTicket,
  ]);

  if (!id) return null;

  const actionable =
    !!taskApproval && !loading && !loadError && approvable && !deciding && !chatBusy && !batchApproving;
  const approveLabel = status === "backlog" ? "批准开工" : "通过";

  return (
    <div className="oc-surface-card mt-1.5 overflow-hidden rounded-lg border-accent/35 not-prose">
      <div className="flex min-h-11 items-center gap-2.5 border-b border-border/75 bg-bg/40 px-3 py-2">
        <span className="oc-icon-badge oc-icon-badge-accent size-6">
          <ClipboardCheck size={13} strokeWidth={1.75} />
        </span>
        <span className="text-body font-semibold tracking-[-0.005em] text-fg">任务待你确认</span>
        <span className="ml-auto">
          {loading ? (
            <Spinner />
          ) : loadError ? (
            <Badge tone="danger" size="sm">
              <AlertTriangle className="size-3" strokeWidth={1.75} />
              无法核验
            </Badge>
          ) : status ? (
            <Badge tone={statusTone(status)} size="sm">
              {TICKET_STATUS_LABEL[status]}
            </Badge>
          ) : null}
        </span>
      </div>

      <div className="px-3 py-2.5">
        {loading ? (
          <div className="flex items-center gap-2 py-1 text-body text-faint">
            <Spinner /> 正在核验任务单…
          </div>
        ) : loadError ? (
          <div className="oc-callout oc-callout-danger flex flex-wrap items-center justify-between gap-2 rounded-md px-3 py-2">
            <span className="text-body text-danger">{loadError}</span>
            {taskApproval && (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                data-testid="task-approval-retry-load"
                onClick={() => setReloadTick((n) => n + 1)}
              >
                <RotateCcw className="size-3.5" strokeWidth={1.75} />
                重试加载
              </Button>
            )}
          </div>
        ) : !taskApproval ? (
          <div className="py-1 text-body text-muted">此会话中不可交互，请打开任务面板处理。</div>
        ) : ticket ? (
          <>
            <p className="font-mono text-caption text-faint tabular-nums">
              {ticket.identifier}
              {ticket.type ? ` · ${TICKET_TYPE_LABEL[ticket.type as TicketType] ?? ticket.type}` : ""}
              {ticket.priority ? ` · ${ticket.priority}` : ""}
            </p>
            <p className="mt-1 text-section font-semibold text-fg">{ticket.title}</p>
            {prompt ? <p className="mt-1 text-body leading-snug text-muted">{prompt}</p> : null}
            {ticket.body ? (
              <div className="mt-2">
                {bodyExpanded ? (
                  <div
                    data-testid="task-approval-body-expanded"
                    className="oc-surface-recessed rounded-md px-3 py-2.5 text-meta leading-relaxed text-muted [&_.prose]:text-meta [&_.prose]:leading-relaxed"
                  >
                    <Markdown readOnly>{ticket.body}</Markdown>
                  </div>
                ) : (
                  <p className="oc-surface-recessed line-clamp-3 whitespace-pre-wrap rounded-md px-3 py-2 text-body leading-snug text-muted">
                    {ticket.body}
                  </p>
                )}
                {(ticket.body.length > 140 || ticket.body.includes("\n")) && (
                  <button
                    type="button"
                    data-testid="task-approval-body-toggle"
                    aria-expanded={bodyExpanded}
                    onClick={() => setBodyExpanded((v) => !v)}
                    className="mt-1.5 inline-flex items-center gap-1 rounded-xs text-caption font-medium text-accent outline-none transition-colors hover:text-accent-strong hover:underline focus-visible:ring-2 focus-visible:ring-ring [@media(hover:none)]:min-h-11"
                  >
                    <ChevronDown className={cn("size-3.5 transition-transform duration-150", bodyExpanded && "rotate-180")} strokeWidth={1.75} />
                    {bodyExpanded ? "收起详情" : "展开完整详情"}
                  </button>
                )}
              </div>
            ) : null}
          </>
        ) : (
          <div className="py-1 text-body text-muted">未找到任务单 {id}</div>
        )}

        {error ? (
          <p className="oc-callout oc-callout-danger mt-2 rounded-md px-2.5 py-1.5 text-caption text-danger">{error}</p>
        ) : null}
        {chatBusy && approvable && !loading && !loadError ? (
          <output data-testid="task-approval-busy-hint" className="mt-2 block text-caption text-faint">
            等待当前回合结束后可操作
          </output>
        ) : null}
        {settled === "approve" ? (
          <p className="mt-2 text-caption font-medium text-success">
            {awaitingGroupSend ? "已生效 · 待底部汇总发送" : "已在对话中确认"}
          </p>
        ) : null}
        {settled === "reject" ? (
          <p className="mt-2 text-caption font-medium text-danger">
            {awaitingGroupSend ? "已打回 · 待底部汇总发送" : "已打回"}
          </p>
        ) : null}
        {settled === "defer" ? (
          <p className="mt-2 text-caption text-faint">
            {awaitingGroupSend ? "已暂不处理 · 待底部汇总发送" : "已暂不处理"}
          </p>
        ) : null}
        {manualFollowUp ? <p className="mt-1 text-caption text-faint">{manualFollowUp}</p> : null}

        {rejectOpen && approvable && (
          <div className="mt-2.5">
            <Textarea
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              placeholder="打回理由（必填）"
              rows={3}
              disabled={deciding}
            />
          </div>
        )}

        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border/60 pt-2.5">
          {taskApproval && (loading || approvable) && !loadError ? (
            <>
              <Button
                type="button"
                variant="primary"
                size="sm"
                disabled={!actionable}
                loading={deciding && !rejectOpen}
                onClick={onApprove}
              >
                {approveLabel}
              </Button>
              {status === "waiting_human" ? (
                rejectOpen ? (
                  <>
                    <Button
                      type="button"
                      variant="danger"
                      size="sm"
                      disabled={!actionable || rejectReason.trim().length === 0}
                      loading={deciding}
                      onClick={onReject}
                    >
                      确认打回
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      data-testid="task-approval-reject-cancel"
                      disabled={deciding}
                      onClick={() => {
                        setRejectOpen(false);
                        setRejectReason("");
                      }}
                    >
                      取消
                    </Button>
                  </>
                ) : (
                  <Button
                    type="button"
                    variant="danger"
                    size="sm"
                    disabled={!actionable}
                    onClick={() => setRejectOpen(true)}
                  >
                    打回
                  </Button>
                )
              ) : status === "backlog" ? (
                <Button type="button" variant="ghost" size="sm" disabled={!actionable} onClick={onDefer}>
                  暂不批准
                </Button>
              ) : null}
            </>
          ) : null}
          {onOpenTaskboard ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className={cn("ml-auto")}
              onClick={() => onOpenTaskboard(ticket?.identifier ?? id)}
            >
              打开任务单
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
