import { RotateCw } from "lucide-react";
import { useEffect, useState } from "react";
import { Badge, Button, Modal, useToast } from "../../../components/ui";
import {
  type Column,
  CopyChip,
  DataTable,
  FilterBar,
  KeyValue,
  SelectFilter,
  type SelectOption,
  TimeAgo,
} from "../../components";
import { adminGet, apiErrorMessage } from "../../lib/adminApi";
import { FormatJsonValue } from "./diff";
import {
  SECURITY_EVENT_TYPE_LABELS,
  type SecurityEventRow,
  type SecurityEventsResp,
} from "./types";

const PAGE_SIZE = 100;

const TYPE_OPTIONS: SelectOption[] = [
  { label: "全部类型", value: "" },
  { label: SECURITY_EVENT_TYPE_LABELS.route_bypass, value: "route_bypass" },
  { label: SECURITY_EVENT_TYPE_LABELS.route_blocked, value: "route_blocked" },
];

/** 类型徽标：放行=warning，拦截=danger，其余回落 neutral。 */
function typeLabel(type: string): string {
  return SECURITY_EVENT_TYPE_LABELS[type] ?? type;
}

function typeTone(type: string): "warning" | "danger" | "neutral" {
  if (type === "route_bypass") return "warning";
  if (type === "route_blocked") return "danger";
  return "neutral";
}

/** 安全事件详情：元信息 + 完整 detail JSON。 */
function EventDetail({ row }: { row: SecurityEventRow }) {
  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-lg border border-border bg-surface px-4 py-2">
        <KeyValue
          label="类型"
          value={
            <Badge tone={typeTone(row.type)}>
              {typeLabel(row.type)}
            </Badge>
          }
        />
        <KeyValue
          label="触发者"
          value={
            row.actor_user_id ? (
              <CopyChip value={row.actor_user_id} label={`#${row.actor_user_id}`} />
            ) : (
              <span className="text-faint">—</span>
            )
          }
        />
        <KeyValue
          label="对象"
          value={
            row.target ? (
              <span className="font-mono text-[12px] break-all">{row.target}</span>
            ) : (
              <span className="text-faint">—</span>
            )
          }
        />
        <KeyValue label="IP" value={<span className="font-mono text-[12px]">{row.ip ?? "—"}</span>} />
        <KeyValue
          label="User-Agent"
          value={<span className="break-all text-[12px] text-muted">{row.user_agent ?? "—"}</span>}
        />
        <KeyValue label="时间" value={<TimeAgo value={row.created_at} />} />
      </div>
      <div>
        <p className="mb-1.5 text-[12px] font-medium text-faint">detail</p>
        <FormatJsonValue value={row.detail} />
      </div>
    </div>
  );
}

/** detail 单行截断展示（点行看全 JSON）。 */
function detailPreview(detail: unknown): string {
  if (detail == null) return "—";
  try {
    const s = JSON.stringify(detail);
    return s === "{}" ? "—" : s;
  } catch {
    return String(detail);
  }
}

/**
 * 安全事件（语义三分层第二层）：管理员在被拦路由上的放行等安全相关记录。
 * type 下拉过滤 + keyset「加载更多」；行点开看完整 detail JSON（沿用 diff Modal 模式）。
 */
export function SecurityEventsTab() {
  const toast = useToast();
  const [type, setType] = useState("");

  const [rows, setRows] = useState<SecurityEventRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  const [selected, setSelected] = useState<SecurityEventRow | null>(null);

  // type / 刷新 变化 → 废弃在飞、重拉第一页。
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    setRows([]);
    setCursor(null);
    (async () => {
      try {
        const data = await adminGet<SecurityEventsResp>("/security-events", {
          limit: PAGE_SIZE,
          type,
        });
        if (!alive) return;
        setRows(data.rows ?? []);
        setCursor(data.next_before ?? null);
      } catch (e) {
        if (alive) setError(e instanceof Error ? e : new Error(String(e)));
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [type, reloadTick]);

  const loadMore = async () => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const data = await adminGet<SecurityEventsResp>("/security-events", {
        limit: PAGE_SIZE,
        type,
        before: cursor,
      });
      setRows((prev) => [...prev, ...(data.rows ?? [])]);
      setCursor(data.next_before ?? null);
    } catch (e) {
      toast(`加载失败：${apiErrorMessage(e, "请求失败")}`, "error");
    } finally {
      setLoadingMore(false);
    }
  };

  const columns: Column<SecurityEventRow>[] = [
    {
      key: "created_at",
      title: "时间",
      render: (r) => <TimeAgo value={r.created_at} />,
    },
    {
      key: "type",
      title: "类型",
      render: (r) => (
        <Badge tone={typeTone(r.type)}>{typeLabel(r.type)}</Badge>
      ),
    },
    {
      key: "actor_user_id",
      title: "触发者",
      render: (r) =>
        r.actor_user_id ? (
          <CopyChip value={r.actor_user_id} label={`#${r.actor_user_id}`} />
        ) : (
          <span className="text-faint">—</span>
        ),
    },
    {
      key: "target",
      title: "对象",
      render: (r) =>
        r.target ? <CopyChip value={r.target} /> : <span className="text-faint">—</span>,
    },
    {
      key: "ip",
      title: "IP",
      cellClassName: "font-mono text-[12px] text-muted",
      render: (r) => r.ip ?? "—",
    },
    {
      key: "detail",
      title: "detail",
      render: (r) => {
        const s = detailPreview(r.detail);
        return (
          <span className="block max-w-[18rem] truncate font-mono text-[12px] text-muted" title={s}>
            {s}
          </span>
        );
      },
    },
  ];

  return (
    <div className="flex flex-col gap-3">
      <FilterBar>
        <SelectFilter label="类型" value={type} options={TYPE_OPTIONS} onChange={setType} />
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setReloadTick((t) => t + 1)}
          title="刷新"
          aria-label="刷新"
        >
          <RotateCw size={15} />
        </Button>
      </FilterBar>

      {error && <p className="text-sm text-danger">加载失败：{apiErrorMessage(error, "加载失败")}</p>}

      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        loading={loading}
        onRowClick={(r) => setSelected(r)}
        emptyTitle="暂无安全事件"
        emptyHint="调整过滤条件或稍后再试。"
      />

      {cursor && (
        <div className="flex justify-center py-1">
          <Button variant="secondary" size="sm" onClick={loadMore} disabled={loadingMore}>
            {loadingMore ? "加载中…" : "加载更多"}
          </Button>
        </div>
      )}

      <Modal
        open={selected !== null}
        onOpenChange={(o) => !o && setSelected(null)}
        title="安全事件详情"
        className="max-w-2xl"
        footer={
          <Button variant="ghost" onClick={() => setSelected(null)}>
            关闭
          </Button>
        }
      >
        {selected && <EventDetail row={selected} />}
      </Modal>
    </div>
  );
}
