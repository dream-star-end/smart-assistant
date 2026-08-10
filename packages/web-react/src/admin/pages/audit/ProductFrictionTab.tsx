import { Activity, CheckCircle2, RefreshCw, TriangleAlert } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Badge, Button, Card } from "../../../components/ui";
import { type Column, DataTable, StatCard, StatCardRow } from "../../components";
import { adminGet, apiErrorMessage } from "../../lib/adminApi";

type EventRow = {
  surface: string; stage: string; code: string;
  journeys_1d: string; journeys_7d: string; attempts_1d: string; attempts_7d: string;
  failed_7d: string; recovered_7d: string; pending_7d: string; affected_users_7d: string;
};
type ModelRow = {
  model: string; attempts_1d: string; success_1d: string; failures_1d: string; cancellations_1d: string;
  attempts_7d: string; success_7d: string; failures_7d: string; cancellations_7d: string;
};
type CountRow = Record<string, string>;
type ProductFrictionResponse = {
  generated_at: string;
  windows: { operational_days: number; funnel_days: number };
  events: EventRow[];
  models: ModelRow[];
  model_failures: CountRow[];
  images: CountRow[];
  image_attempts: CountRow[];
  orders: CountRow[];
  github: CountRow[];
  ratings: CountRow[];
};

const n = (value: string | undefined) => Number(value ?? 0);
const pct = (part: number, total: number) => total > 0 ? `${((part / total) * 100).toFixed(1)}%` : "—";

const eventColumns: Column<EventRow>[] = [
  { key: "surface", title: "入口", render: (r) => <Badge tone="neutral">{r.surface}</Badge> },
  { key: "stage", title: "阶段" },
  { key: "code", title: "稳定分类", render: (r) => <span className="font-mono text-[12px]">{r.code}</span> },
  { key: "attempts_7d", title: "7 天尝试", align: "right", cellClassName: "tabular-nums" },
  { key: "failed_7d", title: "终局未成功", align: "right", cellClassName: "tabular-nums" },
  { key: "recovered_7d", title: "已恢复", align: "right", cellClassName: "tabular-nums" },
  { key: "pending_7d", title: "进行中", align: "right", cellClassName: "tabular-nums" },
  { key: "affected_users_7d", title: "影响用户", align: "right", cellClassName: "tabular-nums" },
];

const modelColumns: Column<ModelRow>[] = [
  { key: "model", title: "模型", render: (r) => <span className="font-mono text-[12px]">{r.model}</span> },
  { key: "attempts_1d", title: "24 小时尝试", align: "right" },
  { key: "success_1d", title: "成功", align: "right" },
  { key: "failures_1d", title: "失败", align: "right" },
  { key: "cancellations_1d", title: "取消", align: "right" },
  {
    key: "rate", title: "24 小时失败率", align: "right",
    render: (r) => pct(n(r.failures_1d), n(r.attempts_1d) - n(r.cancellations_1d)),
  },
  { key: "attempts_7d", title: "7 天尝试", align: "right" },
];

function SourceCard({ title, rows, fields }: {
  title: string;
  rows: CountRow[];
  fields: Array<{ key: string; label: string }>;
}) {
  return (
    <Card className="p-4">
      <h3 className="mb-3 text-[13px] font-semibold text-fg">{title}</h3>
      <div className="flex flex-col gap-2">
        {rows.length === 0 && <span className="text-[12px] text-faint">暂无记录</span>}
        {rows.map((row, i) => (
          <div key={`${row.model ?? ""}:${row.status ?? row.outcome ?? row.rating ?? ""}:${row.code ?? i}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg bg-hover px-3 py-2 text-[12px]">
            <Badge tone={row.status === "failed" || row.status === "expired" || row.outcome === "failed" || row.outcome === "cancelled" || row.rating === "down" ? "warning" : "neutral"}>
              {row.code ?? row.status ?? row.outcome ?? row.rating ?? "unknown"}
            </Badge>
            {row.model && <span className="font-mono text-[12px] text-fg">{row.model}</span>}
            {row.code && (row.status || row.outcome) && <span className="text-faint">{row.status ?? row.outcome}</span>}
            {fields.map((f) => <span key={f.key} className="text-faint"><b className="font-medium text-fg tabular-nums">{row[f.key] ?? "0"}</b> {f.label}</span>)}
          </div>
        ))}
      </div>
    </Card>
  );
}

export function ProductFrictionTab() {
  const [data, setData] = useState<ProductFrictionResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    void reload;
    let alive = true;
    setLoading(true);
    setError(null);
    adminGet<ProductFrictionResponse>("/product-friction")
      .then((value) => { if (alive) setData(value); })
      .catch((reason) => { if (alive) setError(reason instanceof Error ? reason : new Error(String(reason))); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [reload]);

  const summary = useMemo(() => {
    const attempts = data?.models.reduce((sum, row) => sum + n(row.attempts_1d), 0) ?? 0;
    const failures = data?.models.reduce((sum, row) => sum + n(row.failures_1d), 0) ?? 0;
    const cancellations = data?.models.reduce((sum, row) => sum + n(row.cancellations_1d), 0) ?? 0;
    const recovered = data?.events.reduce((sum, row) => sum + n(row.recovered_7d), 0) ?? 0;
    const pending = data?.events.reduce((sum, row) => sum + n(row.pending_7d), 0) ?? 0;
    return { attempts, failures, cancellations, recovered, pending };
  }, [data]);

  if (error) {
    return (
      <Card className="flex items-center justify-between gap-4 p-4">
        <span className="text-[13px] text-danger">{apiErrorMessage(error, "产品摩擦数据加载失败")}</span>
        <Button size="sm" variant="secondary" onClick={() => setReload((v) => v + 1)}>重试</Button>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-[12px] text-faint">重试是过程，不等于终局失败；模型、图片、订单、GitHub 与评分分别使用各自权威表，不跨来源相加。</p>
        <Button size="sm" variant="secondary" onClick={() => setReload((v) => v + 1)} disabled={loading}>
          <RefreshCw size={14} />刷新
        </Button>
      </div>
      <StatCardRow>
        <StatCard label="24 小时模型尝试" value={summary.attempts.toLocaleString()} icon={Activity} tone="info" loading={loading} />
        <StatCard label="24 小时终局失败" value={summary.failures.toLocaleString()} hint={`排除 ${summary.cancellations} 次用户取消`} icon={TriangleAlert} tone="danger" loading={loading} />
        <StatCard label="7 天自动恢复" value={summary.recovered.toLocaleString()} icon={CheckCircle2} tone="success" loading={loading} />
        <StatCard label="7 天进行中旅程" value={summary.pending.toLocaleString()} icon={TriangleAlert} tone="warning" loading={loading} />
      </StatCardRow>

      <section className="flex flex-col gap-2">
        <h3 className="text-[13px] font-semibold text-fg">模型尝试与终局</h3>
        <DataTable columns={modelColumns} rows={data?.models ?? []} rowKey={(r) => r.model} loading={loading} />
      </section>
      <section className="flex flex-col gap-2">
        <h3 className="text-[13px] font-semibold text-fg">恢复感知事件</h3>
        <DataTable columns={eventColumns} rows={data?.events ?? []} rowKey={(r) => `${r.surface}:${r.stage}:${r.code}`} loading={loading} emptyHint="只有出现摩擦或恢复时才记录，不写成功心跳。" />
      </section>
      <div className="grid gap-3 lg:grid-cols-2">
        <SourceCard title="模型失败分类（7 天）" rows={data?.model_failures ?? []} fields={[{ key: "failures_1d", label: "24 小时" }, { key: "failures_7d", label: "7 天" }, { key: "affected_users_7d", label: "用户" }]} />
        <SourceCard title="图片旅程状态（7 天）" rows={data?.images ?? []} fields={[{ key: "records", label: "记录" }, { key: "affected_users", label: "用户" }]} />
        <SourceCard title="图片上游调用（7 天）" rows={data?.image_attempts ?? []} fields={[{ key: "attempts_1d", label: "24 小时" }, { key: "attempts_7d", label: "7 天" }, { key: "affected_users_7d", label: "用户" }]} />
        <SourceCard title="支付漏斗（30 天）" rows={data?.orders ?? []} fields={[{ key: "orders", label: "订单" }, { key: "affected_users", label: "用户" }, { key: "amount_cents", label: "分" }]} />
        <SourceCard title="GitHub 工作区" rows={data?.github ?? []} fields={[{ key: "selections", label: "选择" }, { key: "stale", label: "超时" }, { key: "deleted_session", label: "已删会话" }, { key: "missing_session", label: "待物化会话" }]} />
        <SourceCard title="响应评分（30 天）" rows={data?.ratings ?? []} fields={[{ key: "ratings", label: "评分" }, { key: "missing_reason", label: "缺原因" }, { key: "missing_trace", label: "缺追踪" }]} />
      </div>
    </div>
  );
}
