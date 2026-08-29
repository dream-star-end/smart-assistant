import { Check, RotateCcw, Save, Search, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Alert, Badge, Button, IconButton, Input, Sheet, Textarea, useToast } from "../../../components/ui";
import { CopyChip, KeyValue, TimeAgo } from "../../components";
import { ApiError, adminGet, adminSend, apiErrorMessage } from "../../lib/adminApi";
import type { TraceInfo, TraceLookupResp } from "../audit/types";
import {
  FEEDBACK_STATUS_LABELS,
  FEEDBACK_STATUS_TONE,
  type FeedbackPriority,
  type FeedbackRow,
} from "./types";

function fmt(ts: string | null): string {
  if (!ts) return "—";
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? ts : d.toLocaleString("zh-CN");
}

/**
 * 反馈详情抽屉（右侧 Sheet）：完整描述 + 上下文 + meta（JSON pretty）+ 请求ID在线反查，
 * open 态可就地确认处理（POST /feedback/:id/ack）。ack 成功回传更新后的行给父组件就地打补丁。
 */
export function FeedbackDetailSheet({
  row,
  open,
  onOpenChange,
  onUpdated,
}: {
  row: FeedbackRow | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onUpdated: (updated: FeedbackRow) => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [traceBusy, setTraceBusy] = useState(false);
  const [traceResult, setTraceResult] = useState<
    | { status: "found"; trace: TraceInfo }
    | { status: "notfound" }
    | { status: "error"; message: string }
    | null
  >(null);
  const [current, setCurrent] = useState(row);
  const [owner, setOwner] = useState(row?.assigned_to ?? "");
  const [priority, setPriority] = useState<FeedbackPriority | "">(row?.priority ?? "");
  const [resolution, setResolution] = useState(row?.resolution ?? "");

  useEffect(() => {
    setCurrent(row);
    setOwner(row?.assigned_to ?? "");
    setPriority(row?.priority ?? "");
    setResolution(row?.resolution ?? "");
    setTraceResult(null);
  }, [row]);

  const acceptUpdate = (updated: FeedbackRow, message: string) => {
    setCurrent(updated);
    setOwner(updated.assigned_to ?? "");
    setPriority(updated.priority ?? "");
    setResolution(updated.resolution ?? "");
    onUpdated(updated);
    toast(message, "success");
  };

  const mutate = async (
    action: "ack" | "assign" | "priority" | "resolution" | "close" | "reopen",
    body: Record<string, unknown>,
    success: string,
  ) => {
    if (!current || busy) return;
    setBusy(true);
    try {
      const resp = await adminSend<{ feedback: FeedbackRow }>(
        "POST",
        `/feedback/${encodeURIComponent(current.id)}/${action}`,
        body,
      );
      acceptUpdate(resp.feedback, success);
    } catch (e) {
      toast(apiErrorMessage(e, "更新失败"), "error");
    } finally {
      setBusy(false);
    }
  };

  const ack = async () => {
    if (!current) return;
    await mutate("ack", {}, `已确认反馈 #${current.id}`);
  };

  const saveOwner = () => {
    const value = owner.trim();
    if (value && !/^[1-9]\d{0,19}$/.test(value)) {
      toast("负责人必须是管理员数字 ID", "error");
      return;
    }
    void mutate("assign", { assigned_to: value || null }, "负责人已更新");
  };

  const lookupTrace = async () => {
    if (!current?.request_id || traceBusy) return;
    setTraceBusy(true);
    setTraceResult(null);
    try {
      const data = await adminGet<TraceLookupResp>(
        `/trace/${encodeURIComponent(current.request_id)}`,
      );
      setTraceResult({ status: "found", trace: data.trace });
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) {
        setTraceResult({ status: "notfound" });
      } else {
        setTraceResult({ status: "error", message: apiErrorMessage(e, "请求失败") });
      }
    } finally {
      setTraceBusy(false);
    }
  };

  const metaText =
    current?.meta && Object.keys(current.meta).length > 0 ? JSON.stringify(current.meta, null, 2) : "（无 meta）";

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      side="right"
      srTitle="反馈详情"
      className="w-[34rem] max-w-[94vw] bg-surface"
    >
      {current && (
        <>
          <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-4">
            <div className="flex items-center gap-2">
              <h2 className="text-[15px] font-semibold text-fg">反馈 #{current.id}</h2>
              <Badge tone={FEEDBACK_STATUS_TONE[current.status]}>
                {FEEDBACK_STATUS_LABELS[current.status]}
              </Badge>
            </div>
            <IconButton size="sm" aria-label="关闭" onClick={() => onOpenChange(false)}>
              <X size={16} />
            </IconButton>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
            <div className="divide-y divide-border">
              <KeyValue label="提交时间" value={fmt(current.created_at)} />
              <KeyValue
                label="用户"
                value={
                  current.user_id ? (
                    <span>
                      {current.username ? `${current.username} ` : ""}
                      <span className="font-mono text-faint">#{current.user_id}</span>
                    </span>
                  ) : (
                    <span className="text-faint">匿名</span>
                  )
                }
              />
              <KeyValue label="分类" value={<Badge tone="neutral">{current.category}</Badge>} />
              {current.handled_by && (
                <KeyValue
                  label="确认操作人"
                  value={
                    <span>
                      admin <span className="font-mono text-faint">#{current.handled_by}</span> ·{" "}
                      {fmt(current.handled_at)}
                    </span>
                  }
                />
              )}
            </div>

            <div className="mt-4">
              <p className="mb-1.5 text-[12px] font-medium text-faint">描述</p>
              <pre className="max-h-52 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-surface px-3 py-2 text-[13px] leading-relaxed text-fg">
                {current.description}
              </pre>
            </div>

            <div className="mt-4">
              <p className="mb-1.5 text-[12px] font-medium text-faint">上下文</p>
              <div className="flex flex-col gap-1.5">
                {current.request_id && (
                  <div className="flex items-center gap-2 text-[12px]">
                    <span className="w-20 shrink-0 text-faint">request_id</span>
                    <CopyChip value={current.request_id} />
                  </div>
                )}
                {current.session_id && (
                  <div className="flex items-center gap-2 text-[12px]">
                    <span className="w-20 shrink-0 text-faint">session_id</span>
                    <CopyChip value={current.session_id} />
                  </div>
                )}
                {current.version && (
                  <div className="flex items-center gap-2 text-[12px]">
                    <span className="w-20 shrink-0 text-faint">version</span>
                    <span className="font-mono text-muted">{current.version}</span>
                  </div>
                )}
                {current.user_agent && (
                  <div className="flex items-start gap-2 text-[12px]">
                    <span className="w-20 shrink-0 text-faint">UA</span>
                    <span className="break-all font-mono text-muted">{current.user_agent}</span>
                  </div>
                )}
              </div>
            </div>

            <div className="mt-4">
              <p className="mb-1.5 text-[12px] font-medium text-faint">meta（JSON）</p>
              <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-surface px-3 py-2 font-mono text-[11.5px] leading-relaxed text-muted">
                {metaText}
              </pre>
            </div>

            {current.request_id && (
              <div className="mt-4">
                <div className="mb-2 flex items-center justify-between gap-3">
                  <p className="text-[12px] font-medium text-faint">请求归属</p>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={traceBusy}
                    onClick={lookupTrace}
                  >
                    <Search size={14} />
                    {traceBusy ? "反查中…" : "一键反查"}
                  </Button>
                </div>
                {traceResult?.status === "found" && (
                  <div className="divide-y divide-border rounded-lg border border-border bg-surface px-3 py-1">
                    <KeyValue
                      label="用户"
                      value={
                        <span>
                          {traceResult.trace.username ? `${traceResult.trace.username} ` : ""}
                          <CopyChip
                            value={traceResult.trace.user_id}
                            label={`#${traceResult.trace.user_id}`}
                          />
                        </span>
                      }
                    />
                    <KeyValue
                      label="会话"
                      value={<CopyChip value={traceResult.trace.session_key} />}
                    />
                    <KeyValue
                      label="Agent"
                      value={traceResult.trace.agent_id ?? <span className="text-faint">—</span>}
                    />
                    <KeyValue
                      label="模型"
                      value={traceResult.trace.model ?? <span className="text-faint">—</span>}
                    />
                    <KeyValue
                      label="时间"
                      value={<TimeAgo value={traceResult.trace.created_at} />}
                    />
                  </div>
                )}
                {traceResult?.status === "notfound" && (
                  <Alert tone="warning">没有找到该请求ID对应的 turn trace。</Alert>
                )}
                {traceResult?.status === "error" && (
                  <Alert tone="danger">反查失败：{traceResult.message}</Alert>
                )}
              </div>
            )}

            <div className="mt-5 rounded-xl border border-border bg-elevated p-4">
              <h3 className="text-[13px] font-semibold text-fg">处理闭环</h3>
              <p className="mt-1 text-[12px] text-faint">
                负责人独立于确认操作人；优先级和解决结论可分别维护。
              </p>
              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                <label className="flex flex-col gap-1.5 text-[12px] font-medium text-muted">
                  负责人
                  <div className="flex gap-2">
                    <Input
                      aria-label="反馈负责人"
                      value={owner}
                      onChange={(event) => setOwner(event.target.value)}
                      placeholder="管理员数字 ID；留空取消指派"
                      inputMode="numeric"
                      disabled={busy}
                    />
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={busy || owner.trim() === (current.assigned_to ?? "")}
                      onClick={saveOwner}
                    >
                      <Save size={14} />保存
                    </Button>
                  </div>
                </label>
                <label className="flex flex-col gap-1.5 text-[12px] font-medium text-muted">
                  优先级
                  <div className="flex gap-2">
                    <select
                      aria-label="反馈优先级"
                      value={priority}
                      onChange={(event) => setPriority(event.target.value as FeedbackPriority | "")}
                      disabled={busy}
                      className="h-9 min-w-0 flex-1 rounded-md border border-border bg-surface px-2.5 text-[12px] text-fg outline-none focus:border-accent focus:ring-2 focus:ring-ring"
                    >
                      <option value="">未设置</option>
                      <option value="low">低</option>
                      <option value="normal">普通</option>
                      <option value="high">高</option>
                      <option value="urgent">紧急</option>
                    </select>
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={busy || priority === (current.priority ?? "")}
                      onClick={() => void mutate("priority", { priority: priority || null }, "优先级已更新")}
                    >
                      <Save size={14} />保存
                    </Button>
                  </div>
                </label>
              </div>
              <label className="mt-4 flex flex-col gap-1.5 text-[12px] font-medium text-muted">
                解决结论
                <Textarea
                  aria-label="反馈解决结论"
                  value={resolution}
                  onChange={(event) => setResolution(event.target.value)}
                  placeholder="记录已采取的处理、用户影响或无需处理的理由"
                  rows={4}
                  disabled={busy}
                />
              </label>
              <div className="mt-2 flex justify-end">
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={busy || resolution.trim() === (current.resolution ?? "")}
                  onClick={() => void mutate("resolution", { resolution: resolution.trim() || null }, "解决结论已更新")}
                >
                  <Save size={14} />保存结论
                </Button>
              </div>
            </div>
          </div>

          <div className="flex flex-wrap justify-end gap-2 border-t border-border px-5 py-4">
            <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
              退出详情
            </Button>
            {current.status === "open" && (
              <Button variant="secondary" onClick={ack} disabled={busy}>
                <Check size={15} />确认收到
              </Button>
            )}
            {current.status !== "closed" ? (
              <Button
                variant="primary"
                onClick={() => void mutate("close", resolution.trim() ? { resolution: resolution.trim() } : {}, "反馈已关闭")}
                disabled={busy}
              >
                <Check size={15} />关闭反馈
              </Button>
            ) : (
              <Button variant="primary" onClick={() => void mutate("reopen", {}, "反馈已重新打开")} disabled={busy}>
                <RotateCcw size={15} />重新打开
              </Button>
            )}
          </div>
        </>
      )}
    </Sheet>
  );
}
