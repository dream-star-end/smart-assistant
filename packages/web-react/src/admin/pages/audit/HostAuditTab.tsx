import { RotateCw } from "lucide-react";
import { useEffect, useState } from "react";
import { Badge, Button, Input, Modal, useToast } from "../../../components/ui";
import {
  type Column,
  CopyChip,
  DataTable,
  FilterBar,
  KeyValue,
  TimeAgo,
} from "../../components";
import { adminGet, apiErrorMessage } from "../../lib/adminApi";
import { FormatJsonValue } from "./diff";
import type { HostAuditResp, HostAuditRow } from "./types";

const PAGE_SIZE = 100;

// 与后端 host-audit handler 一致：host_id 必须是 UUID 才传。
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** hostId 短显（前 8 位 + …），点击复制完整 UUID。 */
function shortHost(hostId: string): string {
  return `${hostId.slice(0, 8)}…`;
}

/** 主机审计详情：元信息 + 完整 detail JSON。 */
function HostAuditDetail({ row }: { row: HostAuditRow }) {
  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-lg border border-border bg-surface px-4 py-2">
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
          value={<span className="font-mono text-[12px] break-all">{row.actor}</span>}
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
              <span className="font-mono text-[12px] break-all">{row.operationId}</span>
            ) : (
              <span className="text-faint">—</span>
            )
          }
        />
        <KeyValue label="时间" value={<TimeAgo value={row.ts} />} />
      </div>
      <div>
        <p className="mb-1.5 text-[12px] font-medium text-faint">detail</p>
        <FormatJsonValue value={row.detail} />
      </div>
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
      cellClassName: "font-mono text-[12px] text-muted",
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
        <Input
          value={dHost}
          onChange={(e) => setDHost(e.target.value)}
          onKeyDown={onKey}
          placeholder="host_id（UUID）"
          className="h-9 w-full sm:w-80"
          aria-label="host_id 过滤"
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
        >
          <RotateCw size={15} />
        </Button>
      </FilterBar>

      {invalid && <p className="text-sm text-warning">host_id 需为 UUID 格式。</p>}
      {error && <p className="text-sm text-danger">加载失败：{apiErrorMessage(error, "加载失败")}</p>}

      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(r) => String(r.id)}
        loading={loading}
        onRowClick={(r) => setSelected(r)}
        emptyTitle="暂无主机审计记录"
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
