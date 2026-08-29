import { RefreshCw } from "lucide-react";
import { useMemo, useState } from "react";
import { Badge, Button, useToast } from "../../../components/ui";
import {
  type Column,
  DataTable,
  FilterBar,
  LevelBadge,
  SelectFilter,
  TimeAgo,
} from "../../components";
import { ApiError, adminGet, adminSend } from "../../lib/adminApi";
import { OUTBOX_STATUS_META } from "./constants";
import { useReloadable } from "./useReloadable";
import type { EventMeta, OutboxRow, OutboxStatus, Severity } from "./types";
import { errText } from "./util";

const MAX_LIMIT = 200;
const PAGE = 50;

const SEVERITY_OPTS: { label: string; value: "" | Severity }[] = [
  { label: "全部严重度", value: "" },
  { label: "critical", value: "critical" },
  { label: "warning", value: "warning" },
  { label: "info", value: "info" },
];
const STATUS_OPTS: { label: string; value: "" | OutboxStatus }[] = [
  { label: "全部状态", value: "" },
  { label: "pending", value: "pending" },
  { label: "sent", value: "sent" },
  { label: "failed", value: "failed" },
  { label: "suppressed", value: "suppressed" },
  { label: "skipped", value: "skipped" },
];

export function OutboxTab({ events }: { events: EventMeta[] }) {
  const toast = useToast();
  const [eventType, setEventType] = useState("");
  const [severity, setSeverity] = useState<"" | Severity>("");
  const [status, setStatus] = useState<"" | OutboxStatus>("");
  const [limit, setLimit] = useState(PAGE);
  const [retrying, setRetrying] = useState<Set<string>>(new Set());

  // severity 后端不支持过滤,前端过滤(对齐 vanilla);event_type/status 走后端。
  const { data, loading, error, reload } = useReloadable<{ rows: OutboxRow[]; next_before: string | null }>(
    () => adminGet("/alerts/outbox", { limit, event_type: eventType, status }),
    [eventType, status, limit],
    { intervalMs: 15_000 },
  );

  const rows = useMemo(() => {
    const r = data?.rows ?? [];
    return severity ? r.filter((x) => x.severity === severity) : r;
  }, [data, severity]);

  const eventOpts = useMemo(
    () => [{ label: "全部事件", value: "" }, ...events.map((e) => ({ label: e.event_type, value: e.event_type }))],
    [events],
  );

  const onRetry = async (r: OutboxRow) => {
    setRetrying((s) => new Set(s).add(r.id));
    try {
      await adminSend("POST", `/alerts/outbox/${encodeURIComponent(r.id)}/retry`);
      toast("已排入重试,dispatcher 5s 内执行", "success");
      reload();
    } catch (e) {
      if (e instanceof ApiError && e.code === "NOT_RETRYABLE") {
        toast("该行不可重试(已发送 / 已耗尽预算 / 状态已变更)", "error");
        reload();
      } else {
        toast(errText(e), "error");
      }
    } finally {
      setRetrying((s) => {
        const n = new Set(s);
        n.delete(r.id);
        return n;
      });
    }
  };

  const columns: Column<OutboxRow>[] = [
    {
      key: "created_at",
      title: "时间",
      width: 96,
      render: (r) => <TimeAgo value={r.created_at} />,
    },
    {
      key: "event_type",
      title: "事件",
      render: (r) => <span className="font-mono text-[12.5px]">{r.event_type}</span>,
    },
    {
      key: "severity",
      title: "严重度",
      width: 92,
      render: (r) => <LevelBadge level={r.severity} />,
    },
    {
      key: "channel_id",
      title: "通道",
      width: 72,
      render: (r) => <span className="font-mono text-[12px] text-faint">{r.channel_id ?? "—"}</span>,
    },
    {
      key: "status",
      title: "状态",
      width: 108,
      render: (r) => {
        const m = OUTBOX_STATUS_META[r.status] ?? { label: r.status, tone: "neutral" as const };
        return <Badge tone={m.tone}>{m.label}</Badge>;
      },
    },
    { key: "attempts", title: "尝试", width: 60, align: "right", cellClassName: "tabular-nums", render: (r) => r.attempts },
    {
      key: "title",
      title: "标题 / 错误",
      render: (r) =>
        r.status === "failed" && r.last_error ? (
          <span className="line-clamp-1 max-w-[360px] text-danger" title={r.last_error}>
            {r.last_error}
          </span>
        ) : (
          <span className="line-clamp-1 max-w-[360px] text-fg">{r.title || "—"}</span>
        ),
    },
    {
      key: "actions",
      title: "操作",
      width: 80,
      align: "right",
      render: (r) =>
        r.status === "failed" && r.attempts < 10 ? (
          <Button variant="secondary" size="sm" onClick={() => onRetry(r)} disabled={retrying.has(r.id)}>
            重试
          </Button>
        ) : null,
    },
  ];

  const canLoadMore = (data?.rows.length ?? 0) >= limit && limit < MAX_LIMIT;

  return (
    <div className="flex flex-col gap-3">
      <FilterBar>
        <SelectFilter label="事件" value={eventType} options={eventOpts} onChange={setEventType} />
        <SelectFilter label="严重度" value={severity} options={SEVERITY_OPTS} onChange={setSeverity} />
        <SelectFilter label="状态" value={status} options={STATUS_OPTS} onChange={setStatus} />
        <Button variant="secondary" size="sm" onClick={reload} disabled={loading}>
          <RefreshCw size={14} className={loading ? "animate-spin" : undefined} /> 刷新
        </Button>
      </FilterBar>

      {error && (
        <div className="rounded-lg border border-danger/40 bg-danger-soft px-3 py-2.5 text-[13px] text-danger">
          加载投递历史失败: {errText(error)}
        </div>
      )}

      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        loading={loading}
        emptyTitle="无投递记录"
        emptyHint="尚无告警进入投递队列,或当前过滤条件下无匹配。"
      />

      {canLoadMore && (
        <div className="flex justify-center">
          <Button variant="ghost" size="sm" onClick={() => setLimit((l) => Math.min(MAX_LIMIT, l + PAGE))}>
            加载更多
          </Button>
        </div>
      )}
    </div>
  );
}
