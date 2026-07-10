import { Download, Inbox, RotateCw } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Badge, Button, EmptyState, Input, useToast } from "../../../components/ui";
import {
  ChartCard,
  type Column,
  DataTable,
  FilterBar,
  PageHeader,
  SelectFilter,
  StatCard,
  StatCardRow,
  donutConfig,
  useChart,
} from "../../components";
import { adminGet, adminText } from "../../lib/adminApi";
import { getAdminPage } from "../../registry";
import { useAdminRoute } from "../../router";

// ── 权威枚举(与 vanilla admin.js:28 + 后端 LEDGER_REASONS 一致)──
const LEDGER_REASONS = [
  "topup",
  "chat",
  "agent_chat",
  "agent_subscription",
  "refund",
  "admin_adjust",
  "promotion",
] as const;
type LedgerReason = (typeof LEDGER_REASONS)[number];
const LEDGER_REASON_LABELS: Record<string, string> = {
  topup: "充值",
  chat: "对话",
  agent_chat: "Agent 对话",
  agent_subscription: "Agent 订阅",
  refund: "退款",
  admin_adjust: "管理员调整",
  promotion: "活动赠送",
};
const LEDGER_CHANNEL_LABELS: Record<string, string> = { web: "网页", wechat: "微信" };
const PAGE_SIZE = 50;

type LedgerRow = {
  id: string;
  user_id: string;
  delta: string;
  balance_after: string;
  reason: string;
  channel: string | null;
  model: string | null;
  memo: string | null;
  created_at: string;
};
type LedgerResp = { rows: LedgerRow[]; next_before: string | null };

type Filter = { userId: string; reason: LedgerReason | ""; from: string; to: string };

/** cents(字符串/数字)→ ¥X.XX(千分位),与 vanilla fmtCents 逐字节等价。 */
function fmtCents(cents: string | number | null | undefined): string {
  if (cents == null) return "¥0.00";
  const s = String(cents);
  if (!/^-?\d+$/.test(s)) return "¥0.00";
  const negative = s.startsWith("-");
  const digits = negative ? s.slice(1) : s;
  const padded = digits.padStart(3, "0");
  const yuan = padded.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const fen = padded.slice(-2);
  return `${negative ? "-" : ""}¥${yuan}.${fen}`;
}

/** ISO → <input type=datetime-local> 的本地显示值。 */
function isoToLocal(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
/** datetime-local 本地值 → ISO;空/非法 → ""。 */
function localToIso(v: string): string {
  if (!v) return "";
  const d = new Date(v);
  return Number.isFinite(d.getTime()) ? d.toISOString() : "";
}
function fmtDateTime(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function triggerCsvDownload(text: string, filename: string): void {
  const blob = new Blob([text], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export default function LedgerPage() {
  const meta = getAdminPage("ledger");
  const { params } = useAdminRoute();
  const toast = useToast();

  // 深链初值(#tab=ledger&user=&reason=&from=&to=)。仅首挂载取一次。
  const initial = useRef<Filter>({
    userId: params.user ?? "",
    reason: (LEDGER_REASONS as readonly string[]).includes(params.reason ?? "")
      ? (params.reason as LedgerReason)
      : "",
    from: params.from ?? "",
    to: params.to ?? "",
  }).current;

  // 已提交的过滤(驱动拉取);草稿在工具栏输入,点「查询」提交。
  const [filter, setFilter] = useState<Filter>(initial);
  const [dUser, setDUser] = useState(initial.userId);
  const [dReason, setDReason] = useState<LedgerReason | "">(initial.reason);
  const [dFrom, setDFrom] = useState(isoToLocal(initial.from));
  const [dTo, setDTo] = useState(isoToLocal(initial.to));

  const [rows, setRows] = useState<LedgerRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [exporting, setExporting] = useState(false);
  const [reloadTick, setReloadTick] = useState(0);

  // 提交的过滤变化(或手动刷新)→ 废弃在飞、重拉第一页。
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    setRows([]);
    setCursor(null);
    setDone(false);
    (async () => {
      try {
        const data = await adminGet<LedgerResp>("/ledger", {
          limit: PAGE_SIZE,
          user_id: filter.userId,
          reason: filter.reason,
          from: filter.from,
          to: filter.to,
        });
        if (!alive) return;
        setRows(data.rows ?? []);
        setCursor(data.next_before ?? null);
        setDone(!data.next_before);
      } catch (e) {
        if (alive) setError(e instanceof Error ? e : new Error(String(e)));
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter, reloadTick]);

  const loadMore = async () => {
    if (done || loadingMore || !cursor) return;
    setLoadingMore(true);
    try {
      const data = await adminGet<LedgerResp>("/ledger", {
        limit: PAGE_SIZE,
        user_id: filter.userId,
        reason: filter.reason,
        from: filter.from,
        to: filter.to,
        before: cursor,
      });
      setRows((prev) => [...prev, ...(data.rows ?? [])]);
      setCursor(data.next_before ?? null);
      setDone(!data.next_before);
    } catch (e) {
      toast(`加载失败：${e instanceof Error ? e.message : String(e)}`, "error");
    } finally {
      setLoadingMore(false);
    }
  };

  const apply = () => {
    setFilter({ userId: dUser.trim(), reason: dReason, from: localToIso(dFrom), to: localToIso(dTo) });
  };
  const clear = () => {
    setDUser("");
    setDReason("");
    setDFrom("");
    setDTo("");
    setFilter({ userId: "", reason: "", from: "", to: "" });
  };

  const exportCsv = async () => {
    setExporting(true);
    try {
      const csv = await adminText("/ledger.csv", {
        user_id: filter.userId,
        reason: filter.reason,
        from: filter.from,
        to: filter.to,
      });
      const now = new Date();
      const pad = (n: number) => String(n).padStart(2, "0");
      const stamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}`;
      triggerCsvDownload(csv, `ledger-${stamp}.csv`);
      toast("CSV 已开始下载", "success");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast(`导出失败：${msg}`, "error");
    } finally {
      setExporting(false);
    }
  };

  // KPI + reason donut over 已加载行(与 vanilla「当前视图」口径一致)。
  const agg = useMemo(() => {
    let totalIn = 0;
    let totalOut = 0;
    const byReason = new Map<string, number>();
    for (const r of rows) {
      const c = Number(r.delta) || 0;
      if (c >= 0) totalIn += c;
      else totalOut += -c;
      byReason.set(r.reason, (byReason.get(r.reason) ?? 0) + Math.abs(c));
    }
    const entries = [...byReason.entries()].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
    return { totalIn, totalOut, net: totalIn - totalOut, entries };
  }, [rows]);

  const donutRef = useRef<HTMLCanvasElement>(null);
  useChart(
    donutRef,
    (theme) =>
      donutConfig(theme, {
        labels: agg.entries.map(([k]) => LEDGER_REASON_LABELS[k] ?? k),
        data: agg.entries.map(([, v]) => Number((v / 100).toFixed(2))),
      }),
    [agg.entries],
  );

  const reasonOptions = [
    { label: "全部 reason", value: "" as const },
    ...LEDGER_REASONS.map((r) => ({ label: LEDGER_REASON_LABELS[r], value: r })),
  ];

  const columns: Column<LedgerRow>[] = [
    { key: "id", title: "id", cellClassName: "font-mono text-[12px] text-muted", render: (r) => r.id },
    { key: "user_id", title: "用户", cellClassName: "font-mono text-[12px]", render: (r) => r.user_id },
    {
      key: "delta",
      title: "delta",
      align: "right",
      cellClassName: "tabular-nums",
      render: (r) => (
        <span className={String(r.delta).startsWith("-") ? "text-danger" : "text-success"}>
          {fmtCents(r.delta)}
        </span>
      ),
    },
    {
      key: "balance_after",
      title: "余额",
      align: "right",
      cellClassName: "tabular-nums text-muted",
      render: (r) => fmtCents(r.balance_after),
    },
    {
      key: "reason",
      title: "reason",
      render: (r) => <Badge tone="neutral">{LEDGER_REASON_LABELS[r.reason] ?? r.reason}</Badge>,
    },
    {
      key: "channel",
      title: "渠道",
      render: (r) => {
        const label = r.channel ? LEDGER_CHANNEL_LABELS[r.channel] : null;
        return label ? (
          <Badge tone={r.channel === "wechat" ? "success" : "neutral"}>{label}</Badge>
        ) : (
          <span className="text-faint">—</span>
        );
      },
    },
    {
      key: "model",
      title: "模型",
      cellClassName: "font-mono text-[12px] text-muted",
      render: (r) => r.model || "—",
    },
    { key: "memo", title: "memo", render: (r) => r.memo || "—" },
    {
      key: "created_at",
      title: "时间",
      cellClassName: "font-mono text-[12px] tabular-nums text-muted",
      render: (r) => fmtDateTime(r.created_at),
    },
  ];

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title={meta.title}
        desc={meta.desc}
        actions={
          <>
            <Button variant="secondary" size="sm" onClick={() => setReloadTick((t) => t + 1)}>
              <RotateCw size={15} />
              刷新
            </Button>
            <Button variant="secondary" size="sm" onClick={exportCsv} disabled={exporting}>
              <Download size={15} />
              {exporting ? "导出中…" : "导出 CSV"}
            </Button>
          </>
        }
      />

      <StatCardRow className="lg:grid-cols-3">
        <StatCard
          label="总入账"
          value={fmtCents(agg.totalIn)}
          hint={`当前 ${rows.length} 条${done ? "" : "+"}`}
          tone="success"
          loading={loading}
        />
        <StatCard
          label="总扣减"
          value={fmtCents(-agg.totalOut)}
          hint="支出合计"
          tone="danger"
          loading={loading}
        />
        <StatCard
          label="净额"
          value={fmtCents(agg.net)}
          hint="入账 − 扣减"
          tone={agg.net >= 0 ? "success" : "danger"}
          loading={loading}
        />
      </StatCardRow>

      <ChartCard title="流水构成" hint="按 reason · 金额(当前视图)">
        {agg.entries.length === 0 ? (
          <div className="flex h-full items-center justify-center text-[13px] text-faint">无记录</div>
        ) : (
          <canvas ref={donutRef} />
        )}
      </ChartCard>

      <div className="flex flex-col gap-3">
        <FilterBar>
          <Input
            value={dUser}
            onChange={(e) => setDUser(e.target.value)}
            placeholder="user_id 过滤"
            className="h-9 w-full sm:w-44"
            onKeyDown={(e) => {
              if (e.key === "Enter") apply();
            }}
          />
          <SelectFilter
            label="reason"
            value={dReason}
            options={reasonOptions}
            onChange={(v) => setDReason(v as LedgerReason | "")}
          />
          <label className="flex items-center gap-1.5 text-[12px] text-muted">
            从
            <Input
              type="datetime-local"
              value={dFrom}
              onChange={(e) => setDFrom(e.target.value)}
              className="h-9 w-auto"
            />
          </label>
          <label className="flex items-center gap-1.5 text-[12px] text-muted">
            至
            <Input
              type="datetime-local"
              value={dTo}
              onChange={(e) => setDTo(e.target.value)}
              className="h-9 w-auto"
            />
          </label>
          <Button variant="primary" size="sm" onClick={apply}>
            查询
          </Button>
          <Button variant="ghost" size="sm" onClick={clear}>
            清空
          </Button>
        </FilterBar>

        {error ? (
          <EmptyState
            icon={Inbox}
            title="加载失败"
            hint={error.message}
            action={
              <Button variant="secondary" size="sm" onClick={() => setReloadTick((t) => t + 1)}>
                重试
              </Button>
            }
          />
        ) : (
          <>
            <DataTable
              columns={columns}
              rows={rows}
              rowKey={(r) => r.id}
              loading={loading}
              emptyTitle="无记录"
              emptyHint="当前过滤条件下没有流水"
            />
            {!done && rows.length > 0 && (
              <div className="flex justify-center">
                <Button variant="secondary" size="sm" onClick={loadMore} disabled={loadingMore}>
                  {loadingMore ? "加载中…" : "加载更多"}
                </Button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
