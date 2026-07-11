import { Search } from "lucide-react";
import { useState } from "react";
import { Button, Input, Modal, useToast } from "../../../components/ui";
import { CopyChip, KeyValue, TimeAgo } from "../../components";
import { ApiError, adminGet } from "../../lib/adminApi";
import type { TraceInfo, TraceLookupResp } from "./types";

/** 反查结果卡：turn_traces 命中后的用户 / 会话 / agent / 模型 / 时间。 */
function TraceCard({ trace }: { trace: TraceInfo }) {
  return (
    <div className="rounded-lg border border-border bg-surface px-4 py-2">
      <KeyValue
        label="trace_id"
        value={<CopyChip value={trace.trace_id} />}
      />
      <KeyValue
        label="用户"
        value={
          <span>
            {trace.username ? `${trace.username} ` : ""}
            <CopyChip value={trace.user_id} label={`#${trace.user_id}`} />
          </span>
        }
      />
      <KeyValue label="会话" value={<CopyChip value={trace.session_key} />} />
      <KeyValue
        label="Agent"
        value={
          trace.agent_id ? (
            <span className="font-mono text-[12px] break-all">{trace.agent_id}</span>
          ) : (
            <span className="text-faint">—</span>
          )
        }
      />
      <KeyValue
        label="模型"
        value={
          trace.model ? (
            <span className="font-mono text-[12px] break-all">{trace.model}</span>
          ) : (
            <span className="text-faint">—</span>
          )
        }
      />
      <KeyValue label="时间" value={<TimeAgo value={trace.created_at} />} />
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
        toast(`反查失败：${e instanceof Error ? e.message : String(e)}`, "error");
      }
    } finally {
      setBusy(false);
    }
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") lookup();
  };

  return (
    <div className="flex items-center gap-2">
      <Input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKey}
        placeholder="请求ID（trace_id）反查"
        className="h-9 w-full sm:w-56"
        aria-label="请求ID反查输入"
      />
      <Button variant="secondary" size="sm" onClick={lookup} disabled={busy} className="gap-1.5">
        <Search size={14} />
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
          <p className="py-6 text-center text-sm text-muted">未找到该请求ID</p>
        ) : null}
      </Modal>
    </div>
  );
}
