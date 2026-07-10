import { CircleSlash, Network, Plus, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button, useConfirm, useToast } from "../../../components/ui";
import {
  ChartCard,
  type Column,
  DataTable,
  FilterBar,
  PageHeader,
  SelectFilter,
  StatCard,
  StatCardRow,
  TimeAgo,
  donutConfig,
  useChart,
} from "../../components";
import { ApiError, adminGet, adminSend } from "../../lib/adminApi";
import { getAdminPage } from "../../registry";
import { EgressProxyFormModal } from "./EgressProxyFormModal";
import { type EgressProxyRow, EGRESS_STATUSES } from "./types";

const STATUS_KEY = "admin_ep_status";

function errMsg(e: unknown): string {
  return e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e);
}

export default function EgressProxiesPage() {
  const meta = getAdminPage("egressProxies");
  const toast = useToast();
  const [confirm, confirmEl] = useConfirm();

  const [rows, setRows] = useState<EgressProxyRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string>(() => sessionStorage.getItem(STATUS_KEY) || "");
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);

  // 首载 + 手动刷新(egressProxies 不在 30s 自动轮询名单)。全量拉,客户端按 status 过滤,
  // 使 KPI / donut 口径稳定不随过滤器抖动(池总量 < 500,一次全拉安全)。
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    void adminGet<{ rows: EgressProxyRow[] }>("/egress-proxies", { limit: 500 })
      .then((d) => {
        if (alive) setRows(Array.isArray(d.rows) ? d.rows : []);
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
  }, [tick]);

  const [formRow, setFormRow] = useState<EgressProxyRow | null | undefined>(undefined);
  // undefined = 关闭;null = 新建;row = 编辑
  const formOpen = formRow !== undefined;

  const onStatusChange = useCallback((v: string) => {
    setStatus(v);
    sessionStorage.setItem(STATUS_KEY, v);
  }, []);

  const total = rows.length;
  const activeN = rows.filter((r) => r.status === "active").length;
  const disabledN = rows.filter((r) => r.status === "disabled").length;
  const filtered = status ? rows.filter((r) => r.status === status) : rows;

  const doDelete = useCallback(
    async (r: EgressProxyRow) => {
      const ok = await confirm({
        title: `删除代理 ${r.label}`,
        body: "若仍有账号绑定该代理,后端会拒绝;请先在「账号」页把绑定账号迁到其他代理。",
        danger: true,
        confirmText: "删除",
      });
      if (!ok) return;
      try {
        await adminSend("DELETE", `/egress-proxies/${encodeURIComponent(r.id)}`);
        toast("已删除", "success");
        refresh();
      } catch (e) {
        // 0055 — 409 PROXY_IN_USE 把 bound_account_count surface 出来。
        const bound = e instanceof ApiError ? e.issue("bound_account_count") : undefined;
        toast(`删除失败:${errMsg(e)}${bound ? `(${bound} 个账号仍绑定)` : ""}`, "error");
      }
    },
    [confirm, toast, refresh],
  );

  const columns: Column<EgressProxyRow>[] = [
    { key: "label", title: "label", render: (r) => <span className="font-medium">{r.label}</span> },
    { key: "url_masked", title: "URL(已遮蔽)", render: (r) => <span className="font-mono text-[12px] break-all">{r.url_masked}</span> },
    {
      key: "status",
      title: "status",
      width: 96,
      render: (r) =>
        r.status === "active" ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-success-soft px-2 py-0.5 text-xs font-medium text-success">
            active
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 rounded-full bg-hover px-2 py-0.5 text-xs font-medium text-muted">
            disabled
          </span>
        ),
    },
    { key: "notes", title: "notes", render: (r) => r.notes || <span className="text-faint">—</span> },
    { key: "updated_at", title: "更新时间", width: 120, render: (r) => <TimeAgo value={r.updated_at} className="text-[12px]" /> },
    {
      key: "actions",
      title: "操作",
      align: "right",
      width: 120,
      render: (r) => (
        <div className="flex items-center justify-end gap-1">
          <Button size="sm" variant="ghost" onClick={() => setFormRow(r)}>
            编辑
          </Button>
          <Button size="sm" variant="ghost" className="text-danger" onClick={() => doDelete(r)}>
            删除
          </Button>
        </div>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title={meta.title}
        desc={loading ? "加载中…" : `共 ${filtered.length} 条`}
        actions={
          <>
            <Button variant="secondary" size="sm" onClick={refresh}>
              <RefreshCw size={15} /> 刷新
            </Button>
            <Button variant="primary" size="sm" onClick={() => setFormRow(null)}>
              <Plus size={15} /> 新建代理
            </Button>
          </>
        }
      />

      <StatCardRow>
        <StatCard label="总数" value={total.toLocaleString()} icon={Network} loading={loading} />
        <StatCard label="active" value={activeN.toLocaleString()} tone="success" loading={loading} />
        <StatCard
          label="disabled"
          value={disabledN.toLocaleString()}
          tone={disabledN > 0 ? "warning" : "neutral"}
          icon={CircleSlash}
          loading={loading}
        />
      </StatCardRow>

      <StatusDonut total={total} active={activeN} disabled={disabledN} />

      <FilterBar>
        <SelectFilter
          label="状态"
          value={status}
          onChange={onStatusChange}
          options={[
            { label: "全部", value: "" },
            ...EGRESS_STATUSES.map((s) => ({ label: s, value: s })),
          ]}
        />
      </FilterBar>

      {error ? (
        <div className="rounded-xl border border-danger/40 bg-danger-soft/40 px-4 py-6 text-center text-sm text-danger">
          加载失败:{error}
        </div>
      ) : (
        <DataTable
          columns={columns}
          rows={filtered}
          rowKey={(r) => r.id}
          loading={loading}
          emptyTitle="尚无代理"
        />
      )}

      <EgressProxyFormModal
        open={formOpen}
        onOpenChange={(o) => !o && setFormRow(undefined)}
        row={formRow ?? undefined}
        onSaved={refresh}
      />
      {confirmEl}
    </div>
  );
}

/** 状态构成 donut(active vs disabled)。 */
function StatusDonut({ total, active, disabled }: { total: number; active: number; disabled: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const segs = [
    { label: "active", value: active, token: "success" },
    { label: "disabled", value: disabled, token: "muted" },
  ].filter((s) => s.value > 0);
  useChart(
    ref,
    (theme) =>
      donutConfig(theme, {
        labels: segs.map((s) => s.label),
        data: segs.map((s) => s.value),
        colorTokens: segs.map((s) => s.token),
      }),
    [segs.map((s) => `${s.label}:${s.value}`).join("|")],
  );
  return (
    <ChartCard title="状态构成" hint={`共 ${total} 条`} height={220}>
      {segs.length > 0 ? (
        <canvas ref={ref} />
      ) : (
        <div className="flex h-full items-center justify-center text-sm text-faint">尚无代理</div>
      )}
    </ChartCard>
  );
}
