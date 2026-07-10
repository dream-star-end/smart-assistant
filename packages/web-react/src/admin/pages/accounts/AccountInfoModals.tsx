import { useEffect, useState } from "react";
import { Badge, Modal, Spinner } from "../../../components/ui";
import { DataTable, type Column } from "../../components";
import { ApiError, adminGet } from "../../lib/adminApi";
import { fmtDateTime } from "./cells";
import type { RecentUser, RefreshEvent } from "./types";

function errMsg(e: unknown): string {
  return e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e);
}

/** 通用只读模态数据加载封装。 */
function useModalData<T>(open: boolean, fetcher: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    if (!open) return;
    let alive = true;
    setLoading(true);
    setError(null);
    setData(null);
    void fetcher()
      .then((d) => {
        if (alive) setData(d);
      })
      .catch((e) => {
        if (alive) setError(errMsg(e));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, ...deps]);
  return { data, error, loading };
}

/** OAuth refresh 历史(近 50 条,后端 28 天 retention)。 */
export function RefreshHistoryModal({
  open,
  onOpenChange,
  accountId,
  accountLabel,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accountId: string | null;
  accountLabel: string;
}) {
  const { data, error, loading } = useModalData<RefreshEvent[]>(
    open && accountId != null,
    async () => {
      const r = await adminGet<{ events: RefreshEvent[] }>("/accounts/refresh-events", {
        account_id: accountId ?? "",
        limit: 50,
      });
      return Array.isArray(r.events) ? r.events : [];
    },
    [accountId],
  );

  const columns: Column<RefreshEvent>[] = [
    { key: "ts", title: "时间", width: 150, render: (e) => <span className="font-mono text-[12px]">{fmtDateTime(e.ts)}</span> },
    {
      key: "ok",
      title: "结果",
      width: 90,
      render: (e) =>
        e.ok ? (
          <Badge tone="success">成功</Badge>
        ) : (
          <Badge tone={e.err_code === "network_transient" ? "warning" : "danger"}>
            {e.err_code || "unknown"}
          </Badge>
        ),
    },
    {
      key: "detail",
      title: "详情",
      render: (e) => (e.ok ? <span className="text-faint">—</span> : <span className="font-mono text-[12px] break-all">{e.err_msg || ""}</span>),
    },
  ];

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={`账号 #${accountId ?? ""} — OAuth refresh 历史`}
      description={accountLabel}
      className="max-w-2xl"
    >
      {loading ? (
        <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted">
          <Spinner className="size-4" /> 加载中…
        </div>
      ) : error ? (
        <div className="py-8 text-center text-sm text-danger">加载失败:{error}</div>
      ) : (
        <>
          <DataTable
            columns={columns}
            rows={data ?? []}
            rowKey={(e) => e.id}
            emptyTitle="暂无 refresh 事件"
            emptyHint="该账号暂无记录(28 天 retention)。"
          />
          <p className="mt-2 text-[11.5px] text-faint">
            仅展示最近 50 条;事件保留 28 天。详情字段为后端枚举字面量,不含 raw error。
          </p>
        </>
      )}
    </Modal>
  );
}

/** 近 24h 使用过该账号的用户(按请求量倒序,Top 20)。 */
export function RecentUsersModal({
  open,
  onOpenChange,
  accountId,
  accountLabel,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accountId: string | null;
  accountLabel: string;
}) {
  const { data, error, loading } = useModalData<RecentUser[]>(
    open && accountId != null,
    async () => {
      const r = await adminGet<{ rows: RecentUser[] }>(
        `/accounts/${encodeURIComponent(accountId ?? "")}/recent-users`,
        { hours: 24, limit: 20 },
      );
      return Array.isArray(r.rows) ? r.rows : [];
    },
    [accountId],
  );

  const columns: Column<RecentUser>[] = [
    { key: "user_id", title: "user_id", render: (u) => <span className="font-mono text-[12px]">{u.user_id}</span> },
    { key: "email", title: "email", render: (u) => u.email || <span className="text-faint">—</span> },
    { key: "request_count", title: "请求数", align: "right", cellClassName: "tabular-nums", render: (u) => Number(u.request_count).toLocaleString() },
    { key: "last_used_at", title: "最近使用", width: 150, render: (u) => <span className="font-mono text-[12px]">{fmtDateTime(u.last_used_at)}</span> },
  ];

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={`账号 #${accountId ?? ""} — 近 24h 使用方`}
      description={accountLabel}
      className="max-w-2xl"
    >
      {loading ? (
        <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted">
          <Spinner className="size-4" /> 加载中…
        </div>
      ) : error ? (
        <div className="py-8 text-center text-sm text-danger">加载失败:{error}</div>
      ) : (
        <>
          <DataTable
            columns={columns}
            rows={data ?? []}
            rowKey={(u) => u.user_id}
            emptyTitle="近 24h 无用户使用"
            emptyHint="近 24h 无用户使用过该账号。"
          />
          <p className="mt-2 text-[11.5px] text-faint">仅近 24h、Top 20。</p>
        </>
      )}
    </Modal>
  );
}
