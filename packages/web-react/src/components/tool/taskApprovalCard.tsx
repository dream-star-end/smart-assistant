/**
 * 对话内任务单人工审批卡。展示与操作一律以用户浏览器身份 GET/POST /api/board
 * 为准;agent 工具参数只提供 id / 可选提问,不能伪造单据状态。
 */
import { ClipboardCheck, AlertTriangle } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { ApiError } from "../../lib/api";
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
import { Badge, Button, Spinner, Textarea } from "../ui";
import { useChatInteraction, useToolCardActions } from "./context";

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
  const [ticket, setTicket] = useState<Ticket | null>(null);
  const [loading, setLoading] = useState(() => !!taskApproval);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [deciding, setDeciding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  const [settled, setSettled] = useState<"approve" | "reject" | "defer" | null>(null);
  const [manualFollowUp, setManualFollowUp] = useState<string | null>(null);

  useEffect(() => {
    if (!taskApproval || !id) return;
    let alive = true;
    setLoading(true);
    setLoadError(null);
    taskApproval
      .getTicket(id)
      .then((t) => {
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
  }, [taskApproval, id]);

  const announce = useCallback(
    (message: string) => {
      if (sendUserText) {
        sendUserText(message);
        setManualFollowUp(null);
      } else {
        setManualFollowUp("请回复助手继续。");
      }
    },
    [sendUserText],
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

  const onApprove = useCallback(() => {
    if (!taskApproval || !ticket || deciding) return;
    setDeciding(true);
    setError(null);
    void runWithRetry((t) => taskApproval.approve(t.identifier, t.version))
      .then((next) => {
        if (!next) return;
        setTicket(next);
        setSettled("approve");
        const ident = next.identifier;
        announce(next.status === "ready" && ticket.status === "backlog" ? `已批准开工 ${ident}` : `已通过 ${ident}`);
      })
      .catch((e) => {
        setError(e instanceof ApiError ? taskboardErrorMessage(e, "更新单据失败") : "更新单据失败，请重试");
        void taskApproval
          .getTicket(id)
          .then((t) => setTicket(t))
          .catch(() => {
            /* 刷新失败时保留本地错误 */
          });
      })
      .finally(() => setDeciding(false));
  }, [taskApproval, ticket, deciding, runWithRetry, announce, id]);

  const onReject = useCallback(() => {
    const reason = rejectReason.trim();
    if (!taskApproval || !ticket || deciding || !reason) return;
    setDeciding(true);
    setError(null);
    void runWithRetry((t) => taskApproval.reject(t.identifier, t.version, reason))
      .then((next) => {
        if (!next) return;
        setTicket(next);
        setSettled("reject");
        setRejectOpen(false);
        announce(`已打回 ${next.identifier}：${reason}`);
      })
      .catch((e) => {
        setError(e instanceof ApiError ? taskboardErrorMessage(e, "打回失败") : "打回失败，请重试");
      })
      .finally(() => setDeciding(false));
  }, [taskApproval, ticket, deciding, rejectReason, runWithRetry, announce]);

  const onDefer = useCallback(() => {
    if (deciding || settled) return;
    setSettled("defer");
    announce(`暂不批准 ${ticket?.identifier ?? id}`);
  }, [announce, deciding, settled, ticket, id]);

  if (!id) return null;

  const status = ticket?.status;
  const approvable = !!status && isApprovable(status) && settled === null;
  const actionable =
    !!taskApproval && !loading && !loadError && approvable && !deciding && !chatBusy;
  const approveLabel = status === "backlog" ? "批准开工" : "通过";

  return (
    <div className="mt-1.5 rounded-lg border border-accent/40 bg-surface not-prose">
      <div className="flex min-h-10 items-center gap-2 border-b border-border px-3 py-2">
        <span className="text-accent">
          <ClipboardCheck className="size-4" />
        </span>
        <span className="font-medium text-sm text-fg">任务待你确认</span>
        <span className="ml-auto">
          {loading ? (
            <Spinner />
          ) : loadError ? (
            <span className="inline-flex items-center gap-1 rounded bg-danger/10 px-1.5 py-0.5 text-caption text-danger">
              <AlertTriangle className="size-2.5" />
              无法核验
            </span>
          ) : status ? (
            <Badge tone={statusTone(status)} size="sm">
              {TICKET_STATUS_LABEL[status]}
            </Badge>
          ) : null}
        </span>
      </div>

      <div className="px-3 py-2">
        {loading ? (
          <div className="flex items-center gap-2 py-1 text-body text-faint">
            <Spinner /> 正在核验任务单…
          </div>
        ) : loadError ? (
          <div className="py-1 text-body text-danger">{loadError}</div>
        ) : !taskApproval ? (
          <div className="py-1 text-body text-muted">此会话中不可交互，请打开任务面板处理。</div>
        ) : ticket ? (
          <>
            <p className="text-caption text-faint">
              {ticket.identifier}
              {ticket.type ? ` · ${TICKET_TYPE_LABEL[ticket.type as TicketType] ?? ticket.type}` : ""}
              {ticket.priority ? ` · ${ticket.priority}` : ""}
            </p>
            <p className="mt-1 text-body font-medium text-fg">{ticket.title}</p>
            {prompt ? <p className="mt-1 text-[13px] leading-snug text-muted">{prompt}</p> : null}
            {ticket.body ? (
              <p className="mt-1 line-clamp-3 whitespace-pre-wrap text-[13px] leading-snug text-muted">
                {ticket.body}
              </p>
            ) : null}
          </>
        ) : (
          <div className="py-1 text-body text-muted">未找到任务单 {id}</div>
        )}

        {error ? <p className="mt-2 text-caption text-danger">{error}</p> : null}
        {settled === "approve" ? (
          <p className="mt-2 text-caption text-success">已在对话中确认</p>
        ) : null}
        {settled === "reject" ? <p className="mt-2 text-caption text-danger">已打回</p> : null}
        {settled === "defer" ? <p className="mt-2 text-caption text-faint">已暂不处理</p> : null}
        {manualFollowUp ? <p className="mt-1 text-caption text-faint">{manualFollowUp}</p> : null}

        {rejectOpen && approvable && (
          <div className="mt-2">
            <Textarea
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              placeholder="打回理由（必填）"
              rows={3}
              disabled={deciding}
            />
          </div>
        )}

        <div className="mt-2 flex flex-wrap items-center gap-2">
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
