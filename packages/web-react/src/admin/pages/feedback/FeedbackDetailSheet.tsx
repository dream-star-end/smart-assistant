import { Check, Search, X } from "lucide-react";
import { useState } from "react";
import { Alert, Badge, Button, IconButton, Sheet, useToast } from "../../../components/ui";
import { CopyChip, KeyValue, TimeAgo } from "../../components";
import { ApiError, adminGet, adminSend, apiErrorMessage } from "../../lib/adminApi";
import type { TraceInfo, TraceLookupResp } from "../audit/types";
import { FEEDBACK_STATUS_LABELS, FEEDBACK_STATUS_TONE, type FeedbackRow } from "./types";

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
  onAcked,
}: {
  row: FeedbackRow | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAcked: (updated: FeedbackRow) => void;
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

  const ack = async () => {
    if (!row) return;
    setBusy(true);
    try {
      const resp = await adminSend<{ feedback: FeedbackRow }>(
        "POST",
        `/feedback/${encodeURIComponent(row.id)}/ack`,
        {},
      );
      toast(`已确认反馈 #${row.id}`, "success");
      onAcked(resp.feedback);
      onOpenChange(false);
    } catch (e) {
      toast(apiErrorMessage(e, "确认失败"), "error");
    } finally {
      setBusy(false);
    }
  };

  const lookupTrace = async () => {
    if (!row?.request_id || traceBusy) return;
    setTraceBusy(true);
    setTraceResult(null);
    try {
      const data = await adminGet<TraceLookupResp>(
        `/trace/${encodeURIComponent(row.request_id)}`,
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
    row?.meta && Object.keys(row.meta).length > 0 ? JSON.stringify(row.meta, null, 2) : "（无 meta）";

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      side="right"
      srTitle="反馈详情"
      className="w-[34rem] max-w-[94vw] bg-surface"
    >
      {row && (
        <>
          <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-4">
            <div className="flex items-center gap-2">
              <h2 className="text-[15px] font-semibold text-fg">反馈 #{row.id}</h2>
              <Badge tone={FEEDBACK_STATUS_TONE[row.status]}>
                {FEEDBACK_STATUS_LABELS[row.status]}
              </Badge>
            </div>
            <IconButton size="sm" aria-label="关闭" onClick={() => onOpenChange(false)}>
              <X size={16} />
            </IconButton>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
            <div className="divide-y divide-border">
              <KeyValue label="提交时间" value={fmt(row.created_at)} />
              <KeyValue
                label="用户"
                value={
                  row.user_id ? (
                    <span>
                      {row.username ? `${row.username} ` : ""}
                      <span className="font-mono text-faint">#{row.user_id}</span>
                    </span>
                  ) : (
                    <span className="text-faint">匿名</span>
                  )
                }
              />
              <KeyValue label="分类" value={<Badge tone="neutral">{row.category}</Badge>} />
              {row.handled_by && (
                <KeyValue
                  label="处理人"
                  value={
                    <span>
                      admin <span className="font-mono text-faint">#{row.handled_by}</span> ·{" "}
                      {fmt(row.handled_at)}
                    </span>
                  }
                />
              )}
            </div>

            <div className="mt-4">
              <p className="mb-1.5 text-[12px] font-medium text-faint">描述</p>
              <pre className="max-h-52 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-surface px-3 py-2 text-[13px] leading-relaxed text-fg">
                {row.description}
              </pre>
            </div>

            <div className="mt-4">
              <p className="mb-1.5 text-[12px] font-medium text-faint">上下文</p>
              <div className="flex flex-col gap-1.5">
                {row.request_id && (
                  <div className="flex items-center gap-2 text-[12px]">
                    <span className="w-20 shrink-0 text-faint">request_id</span>
                    <CopyChip value={row.request_id} />
                  </div>
                )}
                {row.session_id && (
                  <div className="flex items-center gap-2 text-[12px]">
                    <span className="w-20 shrink-0 text-faint">session_id</span>
                    <CopyChip value={row.session_id} />
                  </div>
                )}
                {row.version && (
                  <div className="flex items-center gap-2 text-[12px]">
                    <span className="w-20 shrink-0 text-faint">version</span>
                    <span className="font-mono text-muted">{row.version}</span>
                  </div>
                )}
                {row.user_agent && (
                  <div className="flex items-start gap-2 text-[12px]">
                    <span className="w-20 shrink-0 text-faint">UA</span>
                    <span className="break-all font-mono text-muted">{row.user_agent}</span>
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

            {row.request_id && (
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
          </div>

          {row.status === "open" && (
            <div className="flex justify-end gap-2 border-t border-border px-5 py-4">
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                关闭
              </Button>
              <Button variant="primary" onClick={ack} disabled={busy}>
                <Check size={15} />
                确认处理
              </Button>
            </div>
          )}
        </>
      )}
    </Sheet>
  );
}
