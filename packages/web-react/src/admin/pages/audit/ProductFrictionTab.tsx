import {
  Activity,
  Bot,
  CheckCircle2,
  Clock3,
  CreditCard,
  GitBranch,
  Image as ImageIcon,
  Info,
  Layers,
  Link2,
  type LucideIcon,
  MessageSquare,
  RefreshCw,
  ShieldCheck,
  TriangleAlert,
  Users,
} from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { Alert, Badge, Button, Card } from "../../../components/ui";
import { cn } from "../../../lib/utils";
import {
  type Column,
  DataTable,
  PageHeader,
  SectionCard,
  StatCard,
  StatCardRow,
} from "../../components";
import { adminGet, apiErrorMessage } from "../../lib/adminApi";
import { getAdminPage } from "../../registry";

type EventRow = {
  surface: string;
  stage: string;
  code: string;
  journeys_1d: string;
  journeys_7d: string;
  attempts_1d: string;
  attempts_7d: string;
  failed_7d: string;
  recovered_7d: string;
  pending_7d: string;
  affected_users_7d: string;
};
type ModelRow = {
  model: string;
  attempts_1d: string;
  success_1d: string;
  failures_1d: string;
  cancellations_1d: string;
  attempts_7d: string;
  success_7d: string;
  failures_7d: string;
  cancellations_7d: string;
};
type CountRow = Record<string, string>;
type EventWindow = {
  total: number;
  affected_users: number;
  outcomes: {
    failed: number;
    recovered: number;
    succeeded: number;
    abandoned: number;
    pending: number;
    cancelled: number;
  };
  latest_occurrence: string | null;
  trace: { total: number; with_trace: number; missing_trace: number };
};
type ProblemCardFunnelRow = {
  code?: string;
  path?: string;
  reason?: string;
  presentation?: string;
  shown?: number | string;
  recovered?: number | string;
  failed?: number | string;
  cancelled?: number | string;
  pending?: number | string;
  affected_users?: number | string;
  p50_recover_ms?: number | string | null;
  window?: "24h" | "7d" | string;
};
type ProblemCardDecisionRow = {
  code?: string;
  outcome?: string;
  reason?: string;
  count?: number | string;
};
type ProblemCardFallbackRow = {
  code?: string;
  reason?: string;
  count?: number | string;
};
/** 服务端 `problemCards.funnel` 是 `{ last_24h, last_7d }` 双窗对象（audit.ts）；也兼容扁平数组。 */
type ProblemCardFunnelPayload =
  | ProblemCardFunnelRow[]
  | { last_24h?: ProblemCardFunnelRow[]; last_7d?: ProblemCardFunnelRow[] };
type ProblemCardsPayload = {
  funnel?: ProblemCardFunnelPayload;
  decisions?: ProblemCardDecisionRow[];
  jobs?: ProblemCardDecisionRow[];
  fallbacks?: ProblemCardFallbackRow[];
};

/** 把双窗对象展平为带 `window` 标的行；已是数组则原样（缺 window 不补）。 */
export function flattenProblemCardFunnel(
  funnel: ProblemCardFunnelPayload | null | undefined,
): ProblemCardFunnelRow[] {
  if (!funnel) return [];
  if (Array.isArray(funnel)) return funnel;
  const d1 = Array.isArray(funnel.last_24h) ? funnel.last_24h : [];
  const d7 = Array.isArray(funnel.last_7d) ? funnel.last_7d : [];
  return [
    ...d1.map((r) => ({ ...r, window: r.window ?? "24h" })),
    ...d7.map((r) => ({ ...r, window: r.window ?? "7d" })),
  ];
}

type ProductFrictionResponse = {
  generated_at: string;
  windows: { operational_days: number; funnel_days: number };
  event_summary: {
    last_1h: EventWindow;
    last_24h: EventWindow;
    last_7d: EventWindow;
  };
  events: EventRow[];
  models: ModelRow[];
  model_failures: CountRow[];
  images: CountRow[];
  image_attempts: CountRow[];
  orders: CountRow[];
  github: CountRow[];
  ratings: CountRow[];
  problemCards?: ProblemCardsPayload | null;
};

type IconTone = "neutral" | "accent" | "success" | "warning" | "danger" | "info";

const n = (value: string | undefined) => Number(value ?? 0);
const pct = (part: number, total: number) =>
  total > 0 ? `${((part / total) * 100).toFixed(1)}%` : "—";

const eventColumns: Column<EventRow>[] = [
  { key: "surface", title: "入口", render: (r) => <Badge tone="neutral">{r.surface}</Badge> },
  { key: "stage", title: "阶段" },
  {
    key: "code",
    title: "稳定分类",
    render: (r) => <span className="font-mono text-meta">{r.code}</span>,
  },
  { key: "attempts_7d", title: "7 天尝试", align: "right", cellClassName: "tabular-nums" },
  {
    key: "failed_7d",
    title: "终局未成功",
    align: "right",
    cellClassName: "tabular-nums font-medium",
    render: (r) => (
      <span className={n(r.failed_7d) > 0 ? "text-danger" : "text-muted"}>{r.failed_7d}</span>
    ),
  },
  {
    key: "recovered_7d",
    title: "已恢复",
    align: "right",
    cellClassName: "tabular-nums font-medium",
    render: (r) => (
      <span className={n(r.recovered_7d) > 0 ? "text-success" : "text-muted"}>
        {r.recovered_7d}
      </span>
    ),
  },
  { key: "pending_7d", title: "进行中", align: "right", cellClassName: "tabular-nums" },
  {
    key: "affected_users_7d",
    title: "影响用户",
    align: "right",
    cellClassName: "tabular-nums text-muted",
  },
];

function presentationTone(
  value: string | undefined,
): "danger" | "warning" | "info" | "success" | "neutral" {
  if (value === "red") return "danger";
  if (value === "yellow") return "warning";
  if (value === "soft") return "info";
  if (value === "placeholder") return "neutral";
  return "neutral";
}

const problemCardFunnelColumns: Column<ProblemCardFunnelRow>[] = [
  {
    key: "code",
    title: "错误码",
    render: (r) => <span className="font-mono text-meta">{r.code ?? "—"}</span>,
  },
  {
    key: "path",
    title: "路径",
    render: (r) => <span className="font-mono text-meta">{r.path ?? "—"}</span>,
  },
  {
    key: "reason",
    title: "原因",
    render: (r) => <span className="font-mono text-meta">{r.reason || "—"}</span>,
  },
  {
    key: "presentation",
    title: "呈现",
    render: (r) => <Badge tone={presentationTone(r.presentation)}>{r.presentation ?? "—"}</Badge>,
  },
  {
    key: "window",
    title: "窗口",
    render: (r) =>
      r.window ? (
        <Badge tone="neutral" size="sm" className="font-mono">
          {r.window}
        </Badge>
      ) : (
        <span className="text-faint">—</span>
      ),
  },
  {
    key: "shown",
    title: "展示",
    align: "right",
    cellClassName: "tabular-nums",
    render: (r) => n(r.shown == null ? undefined : String(r.shown)),
  },
  {
    key: "recovered",
    title: "已恢复",
    align: "right",
    cellClassName: "tabular-nums text-success",
    render: (r) => n(r.recovered == null ? undefined : String(r.recovered)),
  },
  {
    key: "failed",
    title: "失败",
    align: "right",
    cellClassName: "tabular-nums text-danger",
    render: (r) => n(r.failed == null ? undefined : String(r.failed)),
  },
  {
    key: "cancelled",
    title: "取消",
    align: "right",
    cellClassName: "tabular-nums text-muted",
    render: (r) => n(r.cancelled == null ? undefined : String(r.cancelled)),
  },
  {
    key: "pending",
    title: "进行中",
    align: "right",
    cellClassName: "tabular-nums",
    render: (r) => n(r.pending == null ? undefined : String(r.pending)),
  },
  {
    key: "affected_users",
    title: "用户",
    align: "right",
    cellClassName: "tabular-nums text-muted",
    render: (r) => n(r.affected_users == null ? undefined : String(r.affected_users)),
  },
  {
    key: "p50_recover_ms",
    title: "恢复 p50",
    align: "right",
    cellClassName: "font-mono text-meta tabular-nums text-muted",
    render: (r) =>
      r.p50_recover_ms == null || r.p50_recover_ms === ""
        ? "—"
        : `${n(String(r.p50_recover_ms))}ms`,
  },
];

const problemCardDecisionColumns: Column<ProblemCardDecisionRow>[] = [
  {
    key: "code",
    title: "错误码",
    render: (r) => <span className="font-mono text-meta">{r.code ?? "—"}</span>,
  },
  {
    key: "outcome",
    title: "结果",
    render: (r) => (
      <Badge
        tone={
          r.outcome === "failed" ? "danger" : r.outcome === "recovered" ? "success" : "neutral"
        }
      >
        {r.outcome ?? "—"}
      </Badge>
    ),
  },
  {
    key: "reason",
    title: "原因",
    render: (r) => <span className="font-mono text-meta">{r.reason || "—"}</span>,
  },
  {
    key: "count",
    title: "计数",
    align: "right",
    cellClassName: "tabular-nums font-medium",
    render: (r) => n(r.count == null ? undefined : String(r.count)),
  },
];

const problemCardFallbackColumns: Column<ProblemCardFallbackRow>[] = [
  {
    key: "code",
    title: "错误码",
    render: (r) => <span className="font-mono text-meta">{r.code ?? "—"}</span>,
  },
  {
    key: "reason",
    title: "原因",
    render: (r) => <span className="font-mono text-meta">{r.reason || "—"}</span>,
  },
  {
    key: "count",
    title: "计数",
    align: "right",
    cellClassName: "tabular-nums font-medium",
    render: (r) => n(r.count == null ? undefined : String(r.count)),
  },
];

const modelColumns: Column<ModelRow>[] = [
  {
    key: "model",
    title: "模型",
    render: (r) => <span className="font-mono text-meta font-medium text-fg">{r.model}</span>,
  },
  { key: "attempts_1d", title: "24 小时尝试", align: "right", cellClassName: "tabular-nums" },
  {
    key: "success_1d",
    title: "成功",
    align: "right",
    cellClassName: "tabular-nums text-success",
  },
  {
    key: "failures_1d",
    title: "失败",
    align: "right",
    cellClassName: "tabular-nums",
    render: (r) => (
      <span className={n(r.failures_1d) > 0 ? "font-medium text-danger" : "text-muted"}>
        {r.failures_1d}
      </span>
    ),
  },
  {
    key: "cancellations_1d",
    title: "取消",
    align: "right",
    cellClassName: "tabular-nums text-muted",
  },
  {
    key: "rate",
    title: "24 小时失败率",
    align: "right",
    cellClassName: "tabular-nums",
    render: (r) => {
      const denom = n(r.attempts_1d) - n(r.cancellations_1d);
      const fail = n(r.failures_1d);
      const ratio = denom > 0 ? fail / denom : null;
      const width = ratio == null ? 0 : Math.min(100, Math.max(0, ratio * 100));
      return (
        <div className="inline-flex items-center justify-end gap-2">
          {ratio != null && (
            <span
              aria-hidden="true"
              className="hidden h-1.5 w-14 overflow-hidden rounded-full bg-hover sm:inline-block"
            >
              <span
                className={cn(
                  "oc-progress-fill block h-full rounded-full",
                  ratio > 0.15 ? "bg-danger" : ratio > 0.05 ? "bg-warning" : "bg-success",
                )}
                style={{ width: `${width}%` }}
              />
            </span>
          )}
          <span
            className={cn(
              "font-mono text-meta tabular-nums",
              ratio != null && ratio > 0.15
                ? "font-semibold text-danger"
                : ratio != null && ratio > 0.05
                  ? "font-semibold text-warning"
                  : "text-muted",
            )}
          >
            {pct(fail, denom)}
          </span>
        </div>
      );
    },
  },
  {
    key: "attempts_7d",
    title: "7 天尝试",
    align: "right",
    cellClassName: "tabular-nums text-muted",
  },
];

function SourceCard({
  title,
  icon,
  iconTone = "neutral",
  rows,
  fields,
}: {
  title: string;
  icon: LucideIcon;
  iconTone?: IconTone;
  rows: CountRow[];
  fields: Array<{ key: string; label: string }>;
}) {
  const primaryKey = fields[0]?.key;
  const maxVal = useMemo(() => {
    if (!primaryKey) return 0;
    return rows.reduce((max, row) => Math.max(max, n(row[primaryKey])), 0);
  }, [primaryKey, rows]);

  return (
    <SectionCard
      title={title}
      icon={icon}
      iconTone={iconTone}
      action={
        <span className="oc-badge-craft rounded-full bg-hover px-2 py-0.5 font-mono text-caption text-muted tabular-nums">
          {rows.length} 项
        </span>
      }
      bodyClassName="p-3.5"
    >
      <div className="flex flex-col gap-2">
        {rows.length === 0 && (
          <div className="oc-surface-recessed rounded-lg px-3 py-4 text-center text-meta text-faint">
            暂无记录
          </div>
        )}
        {rows.map((row, i) => {
          const isWarn =
            row.status === "failed" ||
            row.status === "expired" ||
            row.outcome === "failed" ||
            row.outcome === "cancelled" ||
            row.rating === "down";
          const currentVal = primaryKey ? n(row[primaryKey]) : 0;
          const barPct = maxVal > 0 ? Math.max(6, Math.round((currentVal / maxVal) * 100)) : 0;

          return (
            <div
              key={`${row.model ?? ""}:${row.status ?? row.outcome ?? row.rating ?? ""}:${row.code ?? i}`}
              className="oc-surface-recessed flex flex-col gap-2 rounded-lg px-3 py-2.5 text-meta"
            >
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <Badge tone={isWarn ? "warning" : "neutral"}>
                  {row.code ?? row.status ?? row.outcome ?? row.rating ?? "unknown"}
                </Badge>
                {row.model && <span className="font-mono text-meta text-fg">{row.model}</span>}
                {row.code && (row.status || row.outcome) && (
                  <span className="text-faint">{row.status ?? row.outcome}</span>
                )}
                <div className="ml-auto flex flex-wrap items-center gap-x-3 gap-y-1">
                  {fields.map((f) => (
                    <span key={f.key} className="text-faint">
                      <b className="font-medium text-fg tabular-nums">{row[f.key] ?? "0"}</b>{" "}
                      {f.label}
                    </span>
                  ))}
                </div>
              </div>
              {maxVal > 0 && (
                <div className="h-1 w-full overflow-hidden rounded-full bg-hover">
                  <div
                    className={cn(
                      "oc-progress-fill h-full rounded-full",
                      isWarn ? "bg-warning" : "bg-accent",
                    )}
                    style={{ width: `${barPct}%` }}
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </SectionCard>
  );
}

export function ProductFrictionTab({ embedded = false }: { embedded?: boolean } = {}) {
  const meta = getAdminPage("productFriction");
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
      .then((value) => {
        if (alive) setData(value);
      })
      .catch((reason) => {
        if (alive) setError(reason instanceof Error ? reason : new Error(String(reason)));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [reload]);

  const summary = useMemo(() => {
    const attempts = data?.models.reduce((sum, row) => sum + n(row.attempts_1d), 0) ?? 0;
    const failures = data?.models.reduce((sum, row) => sum + n(row.failures_1d), 0) ?? 0;
    const cancellations =
      data?.models.reduce((sum, row) => sum + n(row.cancellations_1d), 0) ?? 0;
    const recovered = data?.events.reduce((sum, row) => sum + n(row.recovered_7d), 0) ?? 0;
    const pending = data?.events.reduce((sum, row) => sum + n(row.pending_7d), 0) ?? 0;
    return { attempts, failures, cancellations, recovered, pending };
  }, [data]);
  const currentWindow = data?.event_summary?.last_1h;
  const latest = data?.event_summary?.last_7d.latest_occurrence;

  const refreshButton = (
    <Button
      size="sm"
      variant="secondary"
      onClick={() => setReload((v) => v + 1)}
      disabled={loading}
      className="gap-1.5"
    >
      <RefreshCw size={14} className={loading ? "animate-spin" : undefined} />
      刷新
    </Button>
  );

  if (error) {
    return (
      <div className="flex flex-col gap-4">
        {!embedded && (
          <PageHeader
            title={meta.title}
            desc={meta.desc}
            icon={Activity}
            actions={refreshButton}
          />
        )}
        <Alert
          tone="danger"
          icon={<TriangleAlert size={16} />}
          title="产品摩擦数据加载失败"
          action={
            <Button size="sm" variant="secondary" onClick={() => setReload((v) => v + 1)}>
              重试
            </Button>
          }
        >
          {apiErrorMessage(error, "产品摩擦数据加载失败")}
        </Alert>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {!embedded && (
        <PageHeader
          title={meta.title}
          desc={meta.desc}
          icon={Activity}
          actions={refreshButton}
        />
      )}

      <div className="oc-callout oc-callout-info flex flex-wrap items-center justify-between gap-3 rounded-xl px-4 py-2.5">
        <div className="flex min-w-0 flex-1 items-center gap-2.5">
          <span className="oc-icon-badge oc-icon-badge-info size-7 rounded-lg">
            <Info size={14} />
          </span>
          <p className="min-w-0 text-meta leading-relaxed text-muted">
            重试是过程，不等于终局失败；这里按时间窗和受影响用户判断当前是否仍在持续。
          </p>
        </div>
        {embedded && refreshButton}
      </div>

      {!loading &&
        currentWindow &&
        (currentWindow.total > 0 ? (
          <Alert
            tone="warning"
            icon={<TriangleAlert size={17} />}
            title="最近 1 小时仍有产品摩擦"
          >
            <span className="tabular-nums">
              {currentWindow.total} 个事件，影响 {currentWindow.affected_users} 位用户；最近发生于
              {latest ? ` ${new Date(latest).toLocaleString("zh-CN")}` : "未知时间"}。
            </span>
          </Alert>
        ) : (
          <Alert tone="success" icon={<CheckCircle2 size={17} />} title="最近 1 小时未继续发生">
            <span className="tabular-nums">
              7 天历史数据仅用于复盘，不代表故障仍在持续。最近一次发生于
              {latest ? ` ${new Date(latest).toLocaleString("zh-CN")}` : "暂无记录"}。
            </span>
          </Alert>
        ))}

      <div className="grid gap-3 md:grid-cols-3">
        <WindowCard
          title="最近 1 小时"
          value={data?.event_summary?.last_1h}
          loading={loading}
          tone={
            !loading && currentWindow
              ? currentWindow.total > 0
                ? "warning"
                : "success"
              : "neutral"
          }
        />
        <WindowCard
          title="最近 24 小时"
          value={data?.event_summary?.last_24h}
          loading={loading}
          tone="info"
        />
        <WindowCard
          title="最近 7 天"
          value={data?.event_summary?.last_7d}
          loading={loading}
          tone="neutral"
        />
      </div>

      <StatCardRow>
        <StatCard
          label="24 小时模型尝试"
          value={summary.attempts.toLocaleString()}
          icon={Activity}
          tone="info"
          loading={loading}
        />
        <StatCard
          label="24 小时终局失败"
          value={summary.failures.toLocaleString()}
          hint={`排除 ${summary.cancellations} 次用户取消`}
          icon={TriangleAlert}
          tone="danger"
          loading={loading}
        />
        <StatCard
          label="7 天自动恢复"
          value={summary.recovered.toLocaleString()}
          icon={CheckCircle2}
          tone="success"
          loading={loading}
        />
        <StatCard
          label="7 天进行中旅程"
          value={summary.pending.toLocaleString()}
          icon={TriangleAlert}
          tone="warning"
          loading={loading}
        />
      </StatCardRow>

      <SectionCard
        title="模型尝试与终局"
        hint="按模型汇总尝试、成功、终局失败与取消，并给出排除用户取消后的失败率"
        icon={Bot}
        iconTone="info"
        bodyClassName="p-0"
      >
        <DataTable
          columns={modelColumns}
          rows={data?.models ?? []}
          rowKey={(r) => r.model}
          loading={loading}
          className="rounded-none border-0 shadow-none"
        />
      </SectionCard>

      <SectionCard
        title="恢复感知事件"
        hint="按入口、阶段与稳定分类汇总 7 天尝试、终局与自动恢复情况"
        icon={ShieldCheck}
        iconTone="success"
        bodyClassName="p-0"
      >
        <DataTable
          columns={eventColumns}
          rows={data?.events ?? []}
          rowKey={(r) => `${r.surface}:${r.stage}:${r.code}`}
          loading={loading}
          emptyHint="只有出现摩擦或恢复时才记录，不写成功心跳。"
          className="rounded-none border-0 shadow-none"
        />
      </SectionCard>

      <ProblemCardsSection cards={data?.problemCards} loading={loading} />

      <div className="grid gap-3 lg:grid-cols-2">
        <SourceCard
          title="模型失败分类（7 天）"
          icon={Bot}
          iconTone="danger"
          rows={data?.model_failures ?? []}
          fields={[
            { key: "failures_1d", label: "24 小时" },
            { key: "failures_7d", label: "7 天" },
            { key: "affected_users_7d", label: "用户" },
          ]}
        />
        <SourceCard
          title="图片旅程状态（7 天）"
          icon={ImageIcon}
          iconTone="warning"
          rows={data?.images ?? []}
          fields={[
            { key: "records", label: "记录" },
            { key: "affected_users", label: "用户" },
          ]}
        />
        <SourceCard
          title="图片上游调用（7 天）"
          icon={Layers}
          iconTone="info"
          rows={data?.image_attempts ?? []}
          fields={[
            { key: "attempts_1d", label: "24 小时" },
            { key: "attempts_7d", label: "7 天" },
            { key: "affected_users_7d", label: "用户" },
          ]}
        />
        <SourceCard
          title="支付漏斗（30 天）"
          icon={CreditCard}
          iconTone="accent"
          rows={data?.orders ?? []}
          fields={[
            { key: "orders", label: "订单" },
            { key: "affected_users", label: "用户" },
            { key: "amount_cents", label: "分" },
          ]}
        />
        <SourceCard
          title="GitHub 工作区"
          icon={GitBranch}
          iconTone="neutral"
          rows={data?.github ?? []}
          fields={[
            { key: "selections", label: "选择" },
            { key: "stale", label: "超时" },
            { key: "deleted_session", label: "已删会话" },
            { key: "missing_session", label: "待物化会话" },
          ]}
        />
        <SourceCard
          title="响应评分（30 天）"
          icon={MessageSquare}
          iconTone="warning"
          rows={data?.ratings ?? []}
          fields={[
            { key: "ratings", label: "评分" },
            { key: "missing_reason", label: "缺原因" },
            { key: "missing_trace", label: "缺追踪" },
          ]}
        />
      </div>
    </div>
  );
}

function ProblemCardsSection({
  cards,
  loading,
}: {
  cards?: ProblemCardsPayload | null;
  loading: boolean;
}) {
  const funnel = flattenProblemCardFunnel(cards?.funnel);
  const decisions = Array.isArray(cards?.decisions) ? cards.decisions : [];
  const jobs = Array.isArray(cards?.jobs) ? cards.jobs : [];
  const fallbacks = Array.isArray(cards?.fallbacks) ? cards.fallbacks : [];

  return (
    <SectionCard
      title="问题卡"
      hint="前端可见问题卡的展示漏斗、恢复裁决、后台任务与可见占位分布"
      icon={Layers}
      iconTone="warning"
      bodyClassName="flex flex-col gap-4"
    >
      <DataTable
        columns={problemCardFunnelColumns}
        rows={funnel}
        rowKey={(r, i) =>
          `${r.window ?? ""}:${r.code ?? ""}:${r.path ?? ""}:${r.reason ?? ""}:${r.presentation ?? ""}:${i}`
        }
        loading={loading}
        emptyTitle="暂无问题卡"
        emptyHint="近窗没有问题卡事件。"
      />
      <div className="grid gap-3 lg:grid-cols-3">
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <h4 className="text-meta font-semibold text-fg">恢复裁决</h4>
            <span className="font-mono text-caption text-faint tabular-nums">
              {decisions.length} 项
            </span>
          </div>
          <DataTable
            columns={problemCardDecisionColumns}
            rows={decisions}
            rowKey={(r, i) => `decision:${r.code ?? ""}:${r.outcome ?? ""}:${r.reason ?? ""}:${i}`}
            loading={loading}
            emptyTitle="暂无裁决"
          />
        </div>
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <h4 className="text-meta font-semibold text-fg">恢复任务</h4>
            <span className="font-mono text-caption text-faint tabular-nums">{jobs.length} 项</span>
          </div>
          <DataTable
            columns={problemCardDecisionColumns}
            rows={jobs}
            rowKey={(r, i) => `job:${r.code ?? ""}:${r.outcome ?? ""}:${r.reason ?? ""}:${i}`}
            loading={loading}
            emptyTitle="暂无任务"
          />
        </div>
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <h4 className="text-meta font-semibold text-fg">可见占位</h4>
            <span className="font-mono text-caption text-faint tabular-nums">
              {fallbacks.length} 项
            </span>
          </div>
          <DataTable
            columns={problemCardFallbackColumns}
            rows={fallbacks}
            rowKey={(r, i) => `fallback:${r.code ?? ""}:${r.reason ?? ""}:${i}`}
            loading={loading}
            emptyTitle="暂无占位"
          />
        </div>
      </div>
    </SectionCard>
  );
}

const WINDOW_ICON_TONE: Record<IconTone, string> = {
  neutral: "oc-icon-badge",
  accent: "oc-icon-badge oc-icon-badge-accent",
  success: "oc-icon-badge oc-icon-badge-success",
  warning: "oc-icon-badge oc-icon-badge-warning",
  danger: "oc-icon-badge oc-icon-badge-danger",
  info: "oc-icon-badge oc-icon-badge-info",
};

function WindowCard({
  title,
  value,
  loading,
  tone = "neutral",
}: {
  title: string;
  value?: EventWindow;
  loading: boolean;
  tone?: IconTone;
}) {
  const traceRate =
    value && value.trace.total > 0
      ? `${((value.trace.with_trace / value.trace.total) * 100).toFixed(1)}%`
      : "—";

  const outcomes = value?.outcomes;
  const outcomeTotal = outcomes
    ? outcomes.failed +
      outcomes.recovered +
      outcomes.succeeded +
      outcomes.abandoned +
      outcomes.pending +
      outcomes.cancelled
    : 0;
  const okCount = outcomes ? outcomes.recovered + outcomes.succeeded : 0;
  const warnCount = outcomes ? outcomes.abandoned + outcomes.pending : 0;
  const failCount = outcomes ? outcomes.failed : 0;
  const cancelCount = outcomes ? outcomes.cancelled : 0;

  return (
    <Card className="min-w-0 p-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className={cn("size-7 rounded-lg", WINDOW_ICON_TONE[tone])}>
            <Clock3 size={14} strokeWidth={1.9} />
          </span>
          <h3 className="text-body font-semibold text-fg">{title}</h3>
        </div>
        {!loading && (
          <span className="oc-badge-craft rounded-full bg-hover px-2 py-0.5 font-mono text-caption text-muted tabular-nums">
            {value?.total ?? 0} 事件
          </span>
        )}
      </div>

      {loading ? (
        <p className="mt-3 text-sm text-faint">加载中…</p>
      ) : (
        <>
          <div className="oc-surface-recessed mt-3 flex flex-wrap gap-x-4 gap-y-2 rounded-lg px-3 py-2">
            <Metric icon={<Activity size={13} />} label="事件" value={value?.total ?? 0} />
            <Metric icon={<Users size={13} />} label="用户" value={value?.affected_users ?? 0} />
            <Metric icon={<Link2 size={13} />} label="trace" value={traceRate} />
          </div>

          {outcomeTotal > 0 && (
            <div
              aria-hidden="true"
              className="mt-2.5 flex h-1.5 w-full overflow-hidden rounded-full bg-hover"
            >
              {okCount > 0 && (
                <div
                  className="oc-progress-fill h-full bg-success"
                  style={{ width: `${(okCount / outcomeTotal) * 100}%` }}
                />
              )}
              {warnCount > 0 && (
                <div
                  className="oc-progress-fill h-full bg-warning"
                  style={{ width: `${(warnCount / outcomeTotal) * 100}%` }}
                />
              )}
              {failCount > 0 && (
                <div
                  className="oc-progress-fill h-full bg-danger"
                  style={{ width: `${(failCount / outcomeTotal) * 100}%` }}
                />
              )}
              {cancelCount > 0 && (
                <div
                  className="oc-progress-fill h-full bg-faint/50"
                  style={{ width: `${(cancelCount / outcomeTotal) * 100}%` }}
                />
              )}
            </div>
          )}

          <div className="mt-3 grid grid-cols-2 gap-1.5 text-caption text-faint sm:grid-cols-3">
            <span>
              失败 <b className="tabular-nums text-danger">{value?.outcomes.failed ?? 0}</b>
            </span>
            <span>
              恢复 <b className="tabular-nums text-success">{value?.outcomes.recovered ?? 0}</b>
            </span>
            <span>
              成功 <b className="tabular-nums text-success">{value?.outcomes.succeeded ?? 0}</b>
            </span>
            <span>
              放弃 <b className="tabular-nums text-warning">{value?.outcomes.abandoned ?? 0}</b>
            </span>
            <span>
              进行中 <b className="tabular-nums text-fg">{value?.outcomes.pending ?? 0}</b>
            </span>
            <span>
              取消 <b className="tabular-nums text-fg">{value?.outcomes.cancelled ?? 0}</b>
            </span>
          </div>

          <p
            className="mt-3 truncate border-t border-border/60 pt-2.5 text-caption text-faint tabular-nums"
            title={value?.latest_occurrence ?? undefined}
          >
            最近：
            {value?.latest_occurrence
              ? new Date(value.latest_occurrence).toLocaleString("zh-CN")
              : "暂无"}
          </p>
        </>
      )}
    </Card>
  );
}

function Metric({
  icon,
  label,
  value,
}: {
  icon: ReactNode;
  label: string;
  value: string | number;
}) {
  return (
    <span className="inline-flex items-center gap-1 text-meta text-muted">
      {icon}
      {label} <b className="tabular-nums text-fg">{value}</b>
    </span>
  );
}
