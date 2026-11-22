import { AlertTriangle, Info, RotateCw, ShieldAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { Badge, Button, Modal, useToast } from "../../../components/ui";
import { cn } from "../../../lib/utils";
import {
  type Column,
  CopyChip,
  DataTable,
  FilterBar,
  KeyValue,
  SectionCard,
  SelectFilter,
  type SelectOption,
  TimeAgo,
} from "../../components";
import { adminGet, apiErrorMessage } from "../../lib/adminApi";
import { PayloadShell } from "./diff";
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

function severityMeta(type: string): {
  callout: string;
  badge: string;
  summary: string;
} {
  if (type === "route_blocked") {
    return {
      callout: "oc-callout-danger",
      badge: "oc-icon-badge-danger",
      summary: "请求已被安全策略阻断，请核对来源 IP 与目标路由。",
    };
  }
  if (type === "route_bypass") {
    return {
      callout: "oc-callout-warning",
      badge: "oc-icon-badge-warning",
      summary: "管理员在受限路由触发了策略放行，请复核操作归属与上下文。",
    };
  }
  return {
    callout: "oc-callout-info",
    badge: "oc-icon-badge-info",
    summary: "安全审计事件记录，点击右侧按钮可复制原始 detail 载荷。",
  };
}

/** 安全事件详情：严重度提示卡 + 元信息 + IDE 级 detail 载荷。 */
function EventDetail({ row }: { row: SecurityEventRow }) {
  const sev = severityMeta(row.type);

  return (
    <div className="flex flex-col gap-4">
      <div className={cn("oc-callout flex items-start gap-3 rounded-xl px-4 py-3", sev.callout)}>
        <span className={cn("oc-icon-badge mt-0.5 size-8 rounded-lg", sev.badge)}>
          <ShieldAlert size={15} strokeWidth={1.9} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={typeTone(row.type)}>{typeLabel(row.type)}</Badge>
            {row.target && (
              <span className="truncate font-mono text-caption text-muted">{row.target}</span>
            )}
          </div>
          <p className="mt-1 text-meta text-muted">{sev.summary}</p>
        </div>
      </div>

      <div className="oc-surface-recessed divide-y divide-border/60 rounded-xl px-4 py-1">
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
              <CopyChip value={row.target} />
            ) : (
              <span className="text-faint">—</span>
            )
          }
        />
        <KeyValue
          label="IP"
          value={<span className="font-mono text-meta tabular-nums">{row.ip ?? "—"}</span>}
        />
        <KeyValue
          label="User-Agent"
          value={<span className="break-all text-meta text-muted">{row.user_agent ?? "—"}</span>}
        />
        <KeyValue
          label="时间"
          value={
            <span className="tabular-nums">
              <TimeAgo value={row.created_at} />
            </span>
          }
        />
      </div>

      <PayloadShell title="detail" value={row.detail} />
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
      cellClassName: "tabular-nums",
      render: (r) => <TimeAgo value={r.created_at} />,
    },
    {
      key: "type",
      title: "类型",
      render: (r) => <Badge tone={typeTone(r.type)}>{typeLabel(r.type)}</Badge>,
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
      cellClassName: "font-mono text-meta tabular-nums text-muted",
      render: (r) => r.ip ?? "—",
    },
    {
      key: "detail",
      title: "detail",
      render: (r) => {
        const s = detailPreview(r.detail);
        return (
          <span className="block max-w-[18rem] truncate font-mono text-meta text-muted" title={s}>
            {s}
          </span>
        );
      },
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <FilterBar>
        <SelectFilter label="类型" value={type} options={TYPE_OPTIONS} onChange={setType} />
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setReloadTick((t) => t + 1)}
          title="刷新"
          aria-label="刷新"
          className="oc-icon-btn-tactile"
        >
          <RotateCw size={15} className={loading ? "animate-spin" : undefined} />
        </Button>
      </FilterBar>

      <div className="oc-callout oc-callout-info flex items-start gap-3 rounded-xl px-4 py-3 text-body leading-relaxed">
        <span className="oc-icon-badge oc-icon-badge-info mt-0.5 size-7 rounded-lg">
          <Info size={14} />
        </span>
        <p className="min-w-0 flex-1 text-muted">
          记录管理策略放行与防火墙阻断的安全审计事件；点击任意行展开上下文与完整 detail 载荷。
        </p>
      </div>

      {error && (
        <div
          role="alert"
          className="oc-callout oc-callout-danger flex items-start gap-3 rounded-xl px-4 py-3 text-body"
        >
          <span className="oc-icon-badge oc-icon-badge-danger mt-0.5 size-7 rounded-lg">
            <AlertTriangle size={14} />
          </span>
          <p className="min-w-0 flex-1 text-danger">
            加载失败：{apiErrorMessage(error, "加载失败")}
          </p>
        </div>
      )}

      <SectionCard
        title="安全事件记录"
        hint="管理员绕过放行与防火墙阻断记录，按时间倒序排列"
        icon={ShieldAlert}
        iconTone="danger"
        action={
          !loading && (
            <span className="oc-badge-craft rounded-full bg-hover px-2.5 py-0.5 font-mono text-caption text-muted tabular-nums">
              已加载 {rows.length.toLocaleString("zh-CN")} 条
            </span>
          )
        }
        bodyClassName="p-0"
      >
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(r) => r.id}
          loading={loading}
          onRowClick={(r) => setSelected(r)}
          emptyTitle="暂无安全事件"
          emptyHint="调整过滤条件或稍后再试。"
          className="rounded-none border-0 shadow-none"
          footer={
            cursor ? (
              <div className="flex justify-center">
                <Button variant="secondary" size="sm" onClick={loadMore} disabled={loadingMore}>
                  {loadingMore ? "加载中…" : "加载更多"}
                </Button>
              </div>
            ) : undefined
          }
        />
      </SectionCard>

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
