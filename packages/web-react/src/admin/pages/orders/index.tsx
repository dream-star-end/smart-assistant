import { Download, Inbox, RotateCw } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Badge,
  Button,
  EmptyState,
  Input,
  Modal,
  Spinner,
  useConfirm,
  usePrompt,
  useToast,
} from "../../../components/ui";
import {
  ChartCard,
  type Column,
  CopyChip,
  DataTable,
  FilterBar,
  KeyValue,
  PageHeader,
  SelectFilter,
  StatCard,
  StatCardRow,
  donutConfig,
  useChart,
} from "../../components";
import { adminGet, adminSend, adminText, apiErrorMessage } from "../../lib/adminApi";
import { getAdminPage } from "../../registry";
import { useAdminRoute } from "../../router";

const ORDER_STATUSES = ["pending", "paid", "expired", "refunded", "canceled"] as const;
type OrderStatus = (typeof ORDER_STATUSES)[number];
const ORDER_STATUS_LABELS: Record<string, string> = {
  pending: "待支付",
  paid: "已支付",
  expired: "已过期",
  refunded: "已退款",
  canceled: "已取消",
};
type BadgeTone = "neutral" | "success" | "warning" | "danger" | "info" | "accent";
const ORDER_STATUS_TONE: Record<string, BadgeTone> = {
  paid: "success",
  pending: "warning",
  expired: "danger",
  refunded: "danger",
  canceled: "danger",
};
const ORDER_STATUS_DONUT_TOKEN: Record<string, string> = {
  paid: "success",
  pending: "warning",
  expired: "muted",
  refunded: "info",
  canceled: "danger",
};
const PAGE_SIZE = 50;

type OrderRow = {
  id: string;
  order_no: string;
  user_id: string;
  username: string | null;
  provider: string;
  provider_order: string | null;
  amount_cents: string;
  credits: string;
  status: string;
  paid_at: string | null;
  expires_at: string;
  created_at: string;
  updated_at: string;
};
type OrderDetail = OrderRow & {
  callback_payload: unknown;
  ledger_id: string | null;
  refunded_ledger_id: string | null;
  kind: string;
  org_id: string | null;
  refund_state: string | null;
  refund_reason: string | null;
  refund_requested_at: string | null;
  refund_hold_ledger_id: string | null;
  provider_refund_no: string | null;
  refund_payload: unknown;
  refunded_at: string | null;
};
type OrdersResp = {
  rows: OrderRow[];
  next_before_created_at: string | null;
  next_before_id: string | null;
};
type OrdersKpi = {
  pending_overdue: number;
  pending_overdue_24h: number;
  callback_conflicts_24h: number;
  paid_24h_count: number;
  paid_24h_amount_cents: string;
};

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
function fmtDateTime(iso: string | null): string {
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

function OrderDetailModal({
  orderNo,
  onClose,
  onChanged,
}: {
  orderNo: string | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const toast = useToast();
  const [promptReason, promptReasonEl] = usePrompt();
  const [confirm, confirmEl] = useConfirm();
  const [order, setOrder] = useState<OrderDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [refunding, setRefunding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detailTick, setDetailTick] = useState(0);

  useEffect(() => {
    if (!orderNo) return;
    let alive = true;
    setLoading(true);
    setError(null);
    setOrder(null);
    (async () => {
      try {
        const data = await adminGet<{ order: OrderDetail }>(
          `/orders/${encodeURIComponent(orderNo)}`,
        );
        if (alive) setOrder(data.order);
      } catch (e) {
        if (alive) setError(apiErrorMessage(e, "请求失败"));
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [orderNo, detailTick]);

  const payloadText = order?.callback_payload
    ? JSON.stringify(order.callback_payload, null, 2)
    : "(无 callback,可能未到账或还在 pending)";
  const refundPayloadText = order?.refund_payload
    ? JSON.stringify(order.refund_payload, null, 2)
    : null;
  const refundStateLabel: Record<string, string> = {
    requested: "已提交，待渠道确认",
    channel_pending: "渠道状态待核对",
    failed_review: "退款失败待人工核对",
    completed: "已完成",
  };

  const requestRefund = async () => {
    if (!order || refunding) return;
    const reason = await promptReason({
      title: "填写退款原因",
      body: (
        <p className="mb-3 text-[13px] leading-relaxed text-muted">
          原因会提交给支付渠道，并可能显示在用户收到的退款通知中。
        </p>
      ),
      placeholder: "例如：用户申请原路退款",
      initial: "用户申请原路退款",
      confirmText: "下一步",
      maxLength: 80,
    });
    if (!reason) return;
    const ok = await confirm({
      title: "确认原路退款？",
      danger: true,
      confirmText: "确认并冻结积分",
      body: (
        <div className="space-y-2 text-[13px] leading-relaxed text-muted">
          <p>
            订单 <span className="font-mono text-fg">{order.order_no}</span>，
            金额 <span className="font-medium text-fg">{fmtCents(order.amount_cents)}</span>。
          </p>
          <p>
            确认后会先从原钱包冻结该订单发放的 <strong className="text-fg">{order.credits}</strong>{" "}
            积分，再向虎皮椒发起唯一一次全额退款请求。
          </p>
          <p>渠道结果不明确时不会自动重试，积分保持冻结，需在渠道后台人工核对。</p>
        </div>
      ),
    });
    if (!ok) return;

    setRefunding(true);
    try {
      const response = await adminSend<{
        refund: { state: string; provider_status: string | null };
      }>("POST", `/orders/${encodeURIComponent(order.order_no)}/refund`, { reason });
      const completed = response.refund.state === "completed";
      toast(
        completed ? "退款已完成" : "退款已提交，权益已冻结，请关注渠道状态",
        completed ? "success" : "info",
      );
      setDetailTick((t) => t + 1);
      onChanged();
    } catch (e) {
      toast(`退款未提交：${apiErrorMessage(e, "请求失败")}`, "error");
      setDetailTick((t) => t + 1);
      onChanged();
    } finally {
      setRefunding(false);
    }
  };

  return (
    <Modal
      open={orderNo !== null}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title={orderNo ? `订单 · ${orderNo}` : "订单"}
      className="max-w-xl"
    >
      {loading ? (
        <div className="flex items-center justify-center py-10">
          <Spinner />
        </div>
      ) : error ? (
        <p className="py-6 text-center text-[13px] text-danger">加载失败：{error}</p>
      ) : order ? (
        <div className="flex flex-col gap-1 divide-y divide-border/60">
          <KeyValue
            label="状态"
            value={
              <Badge tone={ORDER_STATUS_TONE[order.status] ?? "neutral"}>
                {ORDER_STATUS_LABELS[order.status] ?? order.status}
              </Badge>
            }
          />
          <KeyValue
            label="用户"
            value={
              <span>
                {order.username ? `${order.username} ` : ""}
                <span className="font-mono text-muted">#{order.user_id}</span>
              </span>
            }
          />
          <KeyValue
            label="支付通道"
            value={
              <span className="flex items-center justify-end gap-2">
                <Badge tone="neutral">{order.provider}</Badge>
                {order.provider_order && <CopyChip value={order.provider_order} />}
              </span>
            }
          />
          <KeyValue
            label="金额 / 积分"
            value={`${fmtCents(order.amount_cents)} → ${order.credits} 积分`}
          />
          <KeyValue label="创建时间" value={fmtDateTime(order.created_at)} />
          <KeyValue label="支付时间" value={fmtDateTime(order.paid_at)} />
          <KeyValue label="过期时间" value={fmtDateTime(order.expires_at)} />
          <KeyValue label="更新时间" value={fmtDateTime(order.updated_at)} />
          {order.ledger_id && (
            <KeyValue
              label="积分流水"
              value={
                <span className="font-mono text-[12px]">
                  #{order.ledger_id}
                  {order.refunded_ledger_id ? ` · 退款 #${order.refunded_ledger_id}` : ""}
                </span>
              }
            />
          )}
          {order.refund_state && (
            <>
              <KeyValue
                label="退款状态"
                value={
                  <Badge tone={order.refund_state === "completed" ? "success" : "warning"}>
                    {refundStateLabel[order.refund_state] ?? order.refund_state}
                  </Badge>
                }
              />
              <KeyValue label="退款原因" value={order.refund_reason ?? "—"} />
              <KeyValue label="发起时间" value={fmtDateTime(order.refund_requested_at)} />
              <KeyValue label="完成时间" value={fmtDateTime(order.refunded_at)} />
              {order.provider_refund_no && (
                <KeyValue
                  label="渠道退款号"
                  value={<CopyChip value={order.provider_refund_no} />}
                />
              )}
              {order.refund_state !== "completed" && (
                <div className="my-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-[12px] leading-relaxed text-warning">
                  对应积分已冻结。当前结果不能证明渠道退款完成，请在虎皮椒后台人工核对；
                  系统不会自动重复发起退款。
                </div>
              )}
            </>
          )}
          {order.status === "paid" && order.kind === "topup" && !order.refund_state && (
            <div className="flex justify-end py-3">
              <Button variant="danger" size="sm" onClick={requestRefund} disabled={refunding}>
                {refunding ? "提交中…" : "原路退款"}
              </Button>
            </div>
          )}
          {order.status === "paid" && order.kind !== "topup" && !order.refund_state && (
            <div className="my-2 rounded-lg bg-hover px-3 py-2 text-[12px] leading-relaxed text-muted">
              此类订单缺少可安全还原的付款前权益快照，不能自动原路退款，请人工核对处理。
            </div>
          )}
          {refundPayloadText && (
            <div className="pt-3">
              <p className="mb-1.5 text-[12px] text-faint">refund_payload(脱敏渠道结果)</p>
              <pre className="max-h-48 overflow-auto rounded-lg bg-hover p-3 font-mono text-[11px] leading-relaxed text-muted">
                {refundPayloadText}
              </pre>
            </div>
          )}
          <div className="pt-3">
            <p className="mb-1.5 text-[12px] text-faint">callback_payload(支付方原始回调)</p>
            <pre className="max-h-72 overflow-auto rounded-lg bg-hover p-3 font-mono text-[11px] leading-relaxed text-muted">
              {payloadText}
            </pre>
          </div>
        </div>
      ) : (
        <p className="py-6 text-center text-[13px] text-faint">未找到该订单</p>
      )}
      {promptReasonEl}
      {confirmEl}
    </Modal>
  );
}

export default function OrdersPage() {
  const meta = getAdminPage("orders");
  const { params } = useAdminRoute();
  const toast = useToast();

  const initStatus = (ORDER_STATUSES as readonly string[]).includes(params.status ?? "")
    ? (params.status as OrderStatus)
    : "";
  const [status, setStatus] = useState<OrderStatus | "">(initStatus);
  const [userId, setUserId] = useState(params.user ?? "");
  const [dStatus, setDStatus] = useState<OrderStatus | "">(initStatus);
  const [dUser, setDUser] = useState(params.user ?? "");

  const [rows, setRows] = useState<OrderRow[]>([]);
  const [cursor, setCursor] = useState<{ createdAt: string | null; id: string | null }>({
    createdAt: null,
    id: null,
  });
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [exporting, setExporting] = useState(false);
  const [reloadTick, setReloadTick] = useState(0);
  const [kpi, setKpi] = useState<OrdersKpi | null>(null);
  const [detailOrderNo, setDetailOrderNo] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    setRows([]);
    setCursor({ createdAt: null, id: null });
    setDone(false);
    (async () => {
      try {
        const data = await adminGet<OrdersResp>("/orders", {
          limit: PAGE_SIZE,
          status,
          user_id: userId,
        });
        if (!alive) return;
        setRows(data.rows ?? []);
        setCursor({ createdAt: data.next_before_created_at, id: data.next_before_id });
        setDone(!data.next_before_created_at || !data.next_before_id);
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
  }, [status, userId, reloadTick]);

  // KPI 独立失败,不阻塞列表。
  useEffect(() => {
    let alive = true;
    adminGet<{ kpi: OrdersKpi }>("/orders/kpi")
      .then((r) => {
        if (alive) setKpi(r.kpi ?? null);
      })
      .catch(() => {
        /* KPI 拉失败保持空 */
      });
    return () => {
      alive = false;
    };
  }, [reloadTick]);

  const loadMore = async () => {
    if (done || loadingMore || !cursor.createdAt || !cursor.id) return;
    setLoadingMore(true);
    try {
      const data = await adminGet<OrdersResp>("/orders", {
        limit: PAGE_SIZE,
        status,
        user_id: userId,
        before_created_at: cursor.createdAt,
        before_id: cursor.id,
      });
      setRows((prev) => [...prev, ...(data.rows ?? [])]);
      setCursor({ createdAt: data.next_before_created_at, id: data.next_before_id });
      setDone(!data.next_before_created_at || !data.next_before_id);
    } catch (e) {
      toast(`加载失败：${apiErrorMessage(e, "请求失败")}`, "error");
    } finally {
      setLoadingMore(false);
    }
  };

  const apply = () => {
    setStatus(dStatus);
    setUserId(dUser.trim());
  };
  const clear = () => {
    setDStatus("");
    setDUser("");
    setStatus("");
    setUserId("");
  };

  const exportCsv = async () => {
    setExporting(true);
    try {
      const csv = await adminText("/orders.csv", { status, user_id: userId });
      const now = new Date();
      const pad = (n: number) => String(n).padStart(2, "0");
      const stamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}`;
      triggerCsvDownload(csv, `orders-${stamp}.csv`);
      toast("CSV 已开始下载", "success");
    } catch (e) {
      toast(`导出失败：${apiErrorMessage(e, "请求失败")}`, "error");
    } finally {
      setExporting(false);
    }
  };

  const statusAgg = useMemo(() => {
    const by = new Map<string, number>();
    for (const r of rows) by.set(r.status, (by.get(r.status) ?? 0) + 1);
    return [...by.entries()].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  }, [rows]);

  const donutRef = useRef<HTMLCanvasElement>(null);
  useChart(
    donutRef,
    (theme) =>
      donutConfig(theme, {
        labels: statusAgg.map(([k]) => ORDER_STATUS_LABELS[k] ?? k),
        data: statusAgg.map(([, v]) => v),
        colorTokens: statusAgg.map(([k]) => ORDER_STATUS_DONUT_TOKEN[k] ?? "muted"),
      }),
    [statusAgg],
  );

  const statusOptions = [
    { label: "全部状态", value: "" as const },
    ...ORDER_STATUSES.map((s) => ({ label: ORDER_STATUS_LABELS[s], value: s })),
  ];

  const columns: Column<OrderRow>[] = [
    {
      key: "order_no",
      title: "order_no",
      cellClassName: "font-mono text-[12px]",
      render: (r) => r.order_no,
    },
    {
      key: "user_id",
      title: "用户",
      render: (r) => (
        <span>
          {r.username ? `${r.username} ` : ""}
          <span className="font-mono text-[12px] text-muted">#{r.user_id}</span>
        </span>
      ),
    },
    { key: "provider", title: "provider", render: (r) => <Badge tone="neutral">{r.provider}</Badge> },
    {
      key: "amount_cents",
      title: "金额",
      align: "right",
      cellClassName: "tabular-nums",
      render: (r) => fmtCents(r.amount_cents),
    },
    { key: "credits", title: "积分", align: "right", cellClassName: "tabular-nums text-muted", render: (r) => r.credits },
    {
      key: "status",
      title: "状态",
      render: (r) => (
        <Badge tone={ORDER_STATUS_TONE[r.status] ?? "neutral"}>
          {ORDER_STATUS_LABELS[r.status] ?? r.status}
        </Badge>
      ),
    },
    {
      key: "paid_at",
      title: "paid_at",
      cellClassName: "font-mono text-[12px] tabular-nums text-muted",
      render: (r) => fmtDateTime(r.paid_at),
    },
    {
      key: "created_at",
      title: "created_at",
      cellClassName: "font-mono text-[12px] tabular-nums text-muted",
      render: (r) => fmtDateTime(r.created_at),
    },
    {
      key: "actions",
      title: "操作",
      align: "right",
      render: (r) => (
        <Button
          variant="ghost"
          size="sm"
          onClick={(e) => {
            e.stopPropagation();
            setDetailOrderNo(r.order_no);
          }}
        >
          查看
        </Button>
      ),
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

      <StatCardRow>
        <StatCard
          label="24h 卡单"
          value={kpi ? kpi.pending_overdue_24h : "—"}
          hint="超时未支付"
          tone={kpi && kpi.pending_overdue_24h > 0 ? "warning" : "success"}
        />
        <StatCard
          label="累计卡单"
          value={kpi ? kpi.pending_overdue : "—"}
          hint="pending 超时"
          tone={kpi && kpi.pending_overdue > 0 ? "warning" : "success"}
        />
        <StatCard
          label="24h 回调冲突"
          value={kpi ? kpi.callback_conflicts_24h : "—"}
          hint="需人工核对"
          tone={kpi && kpi.callback_conflicts_24h > 0 ? "danger" : "success"}
        />
        <StatCard
          label="24h 已付"
          value={kpi ? kpi.paid_24h_count : "—"}
          hint={kpi ? fmtCents(kpi.paid_24h_amount_cents) : undefined}
          tone="success"
        />
      </StatCardRow>

      <ChartCard title="支付状态构成" hint="当前视图 · 按 status">
        {statusAgg.length === 0 ? (
          <div className="flex h-full items-center justify-center text-[13px] text-faint">无订单</div>
        ) : (
          <canvas ref={donutRef} />
        )}
      </ChartCard>

      <div className="flex flex-col gap-3">
        <FilterBar>
          <SelectFilter
            label="状态"
            value={dStatus}
            options={statusOptions}
            onChange={(v) => setDStatus(v as OrderStatus | "")}
          />
          <Input
            value={dUser}
            onChange={(e) => setDUser(e.target.value)}
            placeholder="user_id 过滤"
            className="h-9 w-full sm:w-44"
            onKeyDown={(e) => {
              if (e.key === "Enter") apply();
            }}
          />
          <Button variant="primary" size="sm" onClick={apply}>
            查询
          </Button>
          <Button variant="ghost" size="sm" onClick={clear}>
            清空过滤
          </Button>
        </FilterBar>

        {error ? (
          <EmptyState
            icon={Inbox}
            title="加载失败"
            hint={apiErrorMessage(error, "加载失败")}
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
              rowKey={(r) => r.order_no}
              loading={loading}
              onRowClick={(r) => setDetailOrderNo(r.order_no)}
              emptyTitle="无订单"
              emptyHint="当前过滤条件下没有订单"
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

      <OrderDetailModal
        orderNo={detailOrderNo}
        onClose={() => setDetailOrderNo(null)}
        onChanged={() => setReloadTick((t) => t + 1)}
      />
    </div>
  );
}
