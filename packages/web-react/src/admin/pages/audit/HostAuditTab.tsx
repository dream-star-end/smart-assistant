import { AlertTriangle, RotateCw, Server } from "lucide-react";
import { useEffect, useState } from "react";
import { Badge, Button, Input, Modal, useToast } from "../../../components/ui";
import {
  type Column,
  CopyChip,
  DataTable,
  FilterBar,
  KeyValue,
  SectionCard,
  TimeAgo,
} from "../../components";
import { adminGet, apiErrorMessage } from "../../lib/adminApi";
import { PayloadShell } from "./diff";
import type { HostAuditResp, HostAuditRow } from "./types";

const PAGE_SIZE = 100;

// 与后端 host-audit handler 一致：host_id 必须是 UUID 才传。
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** hostId 短显（前 8 位 + …），点击复制完整 UUID。 */
function shortHost(hostId: string): string {
  return `${hostId.slice(0, 8)}…`;
}

/** 主机审计详情：元信息 + IDE 级 detail 载荷。 */
function HostAuditDetail({ row }: { row: HostAuditRow }) {
  return (
    <div className="flex flex-col gap-4">
      <div className="oc-surface-recessed divide-y divide-border/60 rounded-xl px-4 py-1">
        <KeyValue label="operation" value={<Badge tone="accent">{row.operation}</Badge>} />
        <KeyValue
          label="host"
          value={
            row.hostId ? (
              <CopyChip value={row.hostId} />
            ) : (
              <span className="text-faint">—</span>
            )
          }
        />
        <KeyValue
          label="actor"
          value={<span className="font-mono text-meta break-all">{row.actor}</span>}
        />
        <KeyValue
          label="reason_code"
          value={
            row.reasonCode ? (
              <Badge tone="neutral">{row.reasonCode}</Badge>
            ) : (
              <span className="text-faint">—</span>
            )
          }
        />
        <KeyValue
          label="operation_id"
          value={
            row.operationId ? (
              <CopyChip value={row.operationId} />
            ) : (
              <span className="text-faint">—</span>
            )
          }
        />
        <KeyValue
          label="时间"
          value={
            <span className="tabular-nums">
              <TimeAgo value={row.ts} />
            </span>
          }
        />
      </div>

      <PayloadShell title="detail" value={row.detail} />
    </div>
  );
}

/** detail 单行截断展示（点行看全 JSON）。 */
function detailPreview(detail: Record<string, unknown>): string {
  try {
    const s = JSON.stringify(detail);
    return !s || s === "{}" ? "—" : s;
  } catch {
    return String(detail);
  }
}

/**
 * 主机审计（compute_host_audit 全量浏览，整改批新增）：此前只在 host 详情弹窗露 20 条。
 * 可选按 host_id（UUID）过滤 + keyset「加载更多」；行点开看完整 detail JSON。
 */
export function HostAuditTab() {
  const toast = useToast();
  const [dHost, setDHost] = useState("");
  const [hostId, setHostId] = useState("");
  const [invalid, setInvalid] = useState(false);

  const [rows, setRows] = useState<HostAuditRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  const [selected, setSelected] = useState<HostAuditRow | null>(null);

  // hostId / 刷新 变化 → 废弃在飞、重拉第一页。
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    setRows([]);
    setCursor(null);
    (async () => {
      try {
        const data = await adminGet<HostAuditResp>("/host-audit", {
          limit: PAGE_SIZE,
          host_id: hostId || undefined,
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
  }, [hostId, reloadTick]);

  const loadMore = async () => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const data = await adminGet<HostAuditResp>("/host-audit", {
        limit: PAGE_SIZE,
        host_id: hostId || undefined,
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

  // 空 → 清过滤看全量；非空须 UUID，否则拦下提示（不发无效请求）。
  const apply = () => {
    const v = dHost.trim();
    if (v && !UUID_RE.test(v)) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    setHostId(v);
  };
  const clear = () => {
    setDHost("");
    setInvalid(false);
    setHostId("");
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") apply();
  };

  const columns: Column<HostAuditRow>[] = [
    {
      key: "ts",
      title: "时间",
      cellClassName: "tabular-nums",
      render: (r) => <TimeAgo value={r.ts} />,
    },
    {
      key: "hostId",
      title: "host",
      render: (r) =>
        r.hostId ? (
          <CopyChip value={r.hostId} label={shortHost(r.hostId)} />
        ) : (
          <span className="text-faint">—</span>
        ),
    },
    {
      key: "operation",
      title: "operation",
      render: (r) => <Badge tone="accent">{r.operation}</Badge>,
    },
    {
      key: "actor",
      title: "actor",
      cellClassName: "font-mono text-meta text-muted",
      render: (r) => <span className="break-all">{r.actor}</span>,
    },
    {
      key: "reasonCode",
      title: "reason_code",
      render: (r) =>
        r.reasonCode ? (
          <Badge tone="neutral">{r.reasonCode}</Badge>
        ) : (
          <span className="text-faint">—</span>
        ),
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
        <Input
          value={dHost}
          onChange={(e) => setDHost(e.target.value)}
          onKeyDown={onKey}
          placeholder="host_id（UUID）"
          className="h-9 w-full font-mono sm:w-80"
          aria-label="host_id 过滤"
          aria-invalid={invalid || undefined}
        />
        <Button variant="primary" size="sm" onClick={apply}>
          查询
        </Button>
        <Button variant="ghost" size="sm" onClick={clear}>
          重置
        </Button>
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

      {invalid && (
        <div
          role="alert"
          className="oc-callout oc-callout-warning flex items-start gap-3 rounded-xl px-4 py-3 text-body"
        >
          <span className="oc-icon-badge oc-icon-badge-warning mt-0.5 size-7 rounded-lg">
            <AlertTriangle size={14} />
          </span>
          <p className="min-w-0 flex-1 text-warning">host_id 需为 UUID 格式。</p>
        </div>
      )}

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
        title="主机操作审计"
        hint="compute_host_audit 全量操作流，点击任意行查看完整 detail 载荷"
        icon={Server}
        iconTone="info"
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
          rowKey={(r) => String(r.id)}
          loading={loading}
          onRowClick={(r) => setSelected(r)}
          emptyTitle="暂无主机审计记录"
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
        title="主机审计详情"
        className="max-w-2xl"
        footer={
          <Button variant="ghost" onClick={() => setSelected(null)}>
            关闭
          </Button>
        }
      >
        {selected && <HostAuditDetail row={selected} />}
      </Modal>
    </div>
  );
}
