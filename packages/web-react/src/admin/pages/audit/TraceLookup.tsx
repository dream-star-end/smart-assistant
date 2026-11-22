import { AlertTriangle, Check, Clock3, Copy, FileSearch, Search, Terminal } from "lucide-react";
import { useState } from "react";
import { Badge, Button, Input, Modal, useToast } from "../../../components/ui";
import { CopyChip, KeyValue, TimeAgo } from "../../components";
import { ApiError, adminGet, apiErrorMessage } from "../../lib/adminApi";
import type { TraceInfo, TraceLookupResp } from "./types";

function formatLocalTs(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString("zh-CN");
}

/** 反查结果卡：turn_traces 命中后的用户 / 会话 / agent / 模型 / 时间 + IDE 级时间线与载荷区。 */
function TraceCard({ trace }: { trace: TraceInfo }) {
  const [copied, setCopied] = useState(false);
  const payloadJson = JSON.stringify(trace, null, 2);
  const localTs = formatLocalTs(trace.created_at);

  const copyPayload = async () => {
    try {
      await navigator.clipboard?.writeText(payloadJson);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      // 忽略剪贴板不可用环境
    }
  };

  return (
    <div className="flex flex-col gap-3.5">
      {/* 命中状态眉条 */}
      <div className="oc-callout oc-callout-info flex items-center justify-between gap-3 rounded-xl px-3.5 py-2.5">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="oc-icon-badge oc-icon-badge-accent size-8 rounded-lg">
            <FileSearch size={15} strokeWidth={1.9} />
          </span>
          <div className="min-w-0">
            <p className="text-body font-semibold text-fg">命中请求归属</p>
            <p className="truncate font-mono text-caption text-muted tabular-nums">{localTs}</p>
          </div>
        </div>
        <span className="oc-badge-craft shrink-0 rounded-full bg-info-soft px-2.5 py-0.5 font-mono text-caption font-medium text-info">
          turn_traces
        </span>
      </div>

      {/* 结构化归属信息卡 */}
      <div className="oc-surface-card divide-y divide-border/60 rounded-xl px-4 py-1">
        <KeyValue label="trace_id" value={<CopyChip value={trace.trace_id} />} />
        <KeyValue
          label="用户"
          value={
            <span className="inline-flex flex-wrap items-center justify-end gap-1.5">
              {trace.username ? <span className="text-fg">{trace.username}</span> : null}
              <CopyChip value={trace.user_id} label={`#${trace.user_id}`} />
            </span>
          }
        />
        <KeyValue label="会话" value={<CopyChip value={trace.session_key} />} />
        <KeyValue
          label="Agent"
          value={
            trace.agent_id ? (
              <span className="font-mono text-meta break-all">{trace.agent_id}</span>
            ) : (
              <span className="text-faint">—</span>
            )
          }
        />
        <KeyValue
          label="模型"
          value={
            trace.model ? (
              <Badge tone="accent" className="font-mono">
                {trace.model}
              </Badge>
            ) : (
              <span className="text-faint">—</span>
            )
          }
        />
        <KeyValue
          label="时间"
          value={
            <span className="tabular-nums">
              <TimeAgo value={trace.created_at} />
            </span>
          }
        />
      </div>

      {/* IDE 级时间线与原始载荷区 */}
      <div className="oc-code-shell">
        <div className="oc-code-shell-header flex flex-wrap items-center justify-between gap-2 px-3.5 py-2">
          <div className="flex items-center gap-2">
            <Terminal size={13.5} className="shrink-0 text-faint" aria-hidden="true" />
            <span className="font-mono text-meta font-semibold text-fg">时间线与归属载荷</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center gap-1 font-mono text-caption text-faint tabular-nums">
              <Clock3 size={11.5} aria-hidden="true" />
              {localTs}
            </span>
            <button
              type="button"
              onClick={copyPayload}
              aria-label="复制追踪载荷"
              title="复制追踪载荷"
              className="oc-icon-btn-tactile inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-caption font-medium text-muted hover:bg-hover hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {copied ? (
                <>
                  <Check size={12} className="text-success" />
                  <span className="text-success">已复制</span>
                </>
              ) : (
                <>
                  <Copy size={12} />
                  <span>复制</span>
                </>
              )}
            </button>
          </div>
        </div>

        {/* 紧凑事件时间线轨道 */}
        <div className="border-b border-border/60 bg-sidebar/40 px-3.5 py-2.5 dark:bg-elevated/35">
          <ol className="flex flex-wrap items-center gap-x-3 gap-y-1.5 font-mono text-caption text-muted tabular-nums">
            <li className="inline-flex items-center gap-1.5">
              <span aria-hidden="true" className="size-1.5 rounded-full bg-success" />
              <span>已记录时间</span>
              <span className="text-fg">{trace.created_at}</span>
            </li>
            <li className="inline-flex items-center gap-1.5">
              <span aria-hidden="true" className="size-1.5 rounded-full bg-accent" />
              <span>归属维度</span>
              <span className="text-fg">
                {[trace.user_id && "user", trace.session_key && "session", trace.agent_id && "agent", trace.model && "model"]
                  .filter(Boolean)
                  .join(" → ")}
              </span>
            </li>
          </ol>
        </div>

        <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words px-3.5 py-3 font-mono text-meta leading-relaxed text-fg tabular-nums">
          {payloadJson}
        </pre>
      </div>
    </div>
  );
}

/**
 * 请求ID反查：输入底部「请求ID」（turn_traces.trace_id）→ 一键查 user / session /
 * agent / model / 时间。命中弹卡片；404 弹「未找到该请求ID」；其余错误走 toast。
 * 此前运维只能 ssh + psql 手查，这里把它抬到审计页头。
 */
export function TraceLookup() {
  const toast = useToast();
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<
    { status: "found"; trace: TraceInfo } | { status: "notfound" } | null
  >(null);

  const lookup = async () => {
    const id = draft.trim();
    if (!id || busy) return;
    setBusy(true);
    try {
      const data = await adminGet<TraceLookupResp>(`/trace/${encodeURIComponent(id)}`);
      setResult({ status: "found", trace: data.trace });
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) {
        setResult({ status: "notfound" });
      } else {
        toast(`反查失败：${apiErrorMessage(e, "请求失败")}`, "error");
      }
    } finally {
      setBusy(false);
    }
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") lookup();
  };

  return (
    <div className="oc-surface-recessed flex w-full items-center gap-1.5 rounded-xl p-1 sm:w-auto">
      <div className="group relative flex-1 sm:flex-initial">
        <Search
          size={14}
          aria-hidden="true"
          className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-faint transition-colors group-focus-within:text-accent"
        />
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKey}
          placeholder="请求ID（trace_id）反查"
          className="oc-field-control h-8 w-full pl-8 pr-2.5 font-mono sm:w-56"
          aria-label="请求ID反查输入"
        />
      </div>
      <Button
        variant="secondary"
        size="sm"
        onClick={lookup}
        disabled={busy}
        className="oc-btn-tactile gap-1.5 rounded-lg"
      >
        <Search size={13.5} />
        {busy ? "反查中…" : "反查"}
      </Button>

      <Modal
        open={result !== null}
        onOpenChange={(o) => !o && setResult(null)}
        title="请求ID反查"
        description="按 turn_traces.trace_id 定位一次请求的归属。"
        className="max-w-lg"
        footer={
          <Button variant="ghost" onClick={() => setResult(null)}>
            关闭
          </Button>
        }
      >
        {result?.status === "found" ? (
          <TraceCard trace={result.trace} />
        ) : result?.status === "notfound" ? (
          <div className="oc-callout oc-callout-warning flex items-start gap-3 rounded-xl px-4 py-4">
            <span className="oc-icon-badge oc-icon-badge-warning mt-0.5 size-8 rounded-lg">
              <AlertTriangle size={15} />
            </span>
            <div className="min-w-0">
              <p className="text-body font-semibold text-fg">未找到该请求ID</p>
              <p className="mt-1 text-meta text-muted">
                请核对底部请求ID（trace_id）是否完整，或该请求尚未写入 turn_traces。
              </p>
            </div>
          </div>
        ) : null}
      </Modal>
    </div>
  );
}
