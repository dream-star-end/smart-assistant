import type { ChartConfiguration } from "chart.js";
import {
  Activity,
  AlertTriangle,
  BellRing,
  Bot,
  Boxes,
  CreditCard,
  Database,
  ExternalLink,
  KeyRound,
  RefreshCw,
  Tag,
  Wrench,
} from "lucide-react";
import { type ReactNode, useCallback, useMemo, useRef } from "react";
import { Badge, Button, Card, useToast } from "../../../components/ui";
import { cn } from "../../../lib/utils";
import {
  type ChartTheme,
  ChartCard,
  type Column,
  DataTable,
  PageHeader,
  SectionCard,
  StatCard,
  StatCardRow,
  type StatTone,
  barConfig,
  donutConfig,
  useChart,
} from "../../components";
import { adminGet, adminText, apiErrorMessage } from "../../lib/adminApi";
import { useAdminPoll } from "../../lib/useAdminPoll";
import {
  type AcctRow,
  type Diagnostics,
  type HealthView,
  type HistRow,
  deriveHealthView,
  positiveEntriesDesc,
  statusColorToken,
} from "./promMetrics";

// ── 格式化（口径对齐 vanilla fmtN / fmtMs / fmtKB） ─────────────────────────
const fmtInt = (n: number): string =>
  Number(n).toLocaleString("en-US", { maximumFractionDigits: 0 });
const fmtMs = (sec: number): string => (sec > 0 ? `${(sec * 1000).toFixed(0)} ms` : "—");
const fmtKB = (bytes: number): string => (bytes > 0 ? `${(bytes / 1024).toFixed(1)} KB` : "—");
const fmtSec = (sec: number): string => (sec > 0 ? `${sec.toFixed(1)} s` : "—");
function fmtUptime(sec?: number): string {
  if (!sec || sec <= 0) return "—";
  const days = Math.floor(sec / 86_400);
  const hrs = Math.floor((sec % 86_400) / 3600);
  const mins = Math.floor((sec % 3600) / 60);
  if (days > 0) return `${days}d ${hrs}h`;
  if (hrs > 0) return `${hrs}h ${mins}m`;
  return `${mins}m`;
}
/** PG 版本串太长（"PostgreSQL 16.2 on x86_64…"），只取前两段。 */
function pgVersionShort(v?: string): string {
  if (!v) return "版本未知";
  const parts = v.split(/\s+/);
  return parts.slice(0, 2).join(" ") || v.slice(0, 40);
}

type SloWindow = {
  success: number;
  failure: number;
  affected_users: number;
  latency_ms: { p50: number | null; p95: number | null };
};

type OpsOverview = {
  slo: {
    source: "durable" | "unavailable" | "since_process_start" | (string & {});
    windows: {
      last_15m: SloWindow;
      last_1h: SloWindow;
      last_24h: SloWindow;
    };
  } | null;
  current_actions: {
    firing_alerts: Array<{ rule_id: string }>;
    open_incidents: Array<{ id: string; condition_key: string; opened_at: string }>;
    stale_alerts: Array<{ rule_id: string }>;
    recovered_alerts: Array<{ rule_id: string }>;
  } | null;
};

type HealthData = {
  metricsText: string;
  diagnostics: Diagnostics | null;
  opsOverview: OpsOverview | null;
};

export default function HealthPage() {
  const toast = useToast();

  // 30s 轮询：metrics(致命) 与 diagnostics(非致命，失败落 null 仍展示 metrics) 并行。
  // 隐藏暂停 / 切回补拉由 useAdminPoll 内置。
  const poll = useAdminPoll<HealthData>(
    async () => {
      const [metricsText, diagnostics, opsOverview] = await Promise.all([
        adminText("/metrics"),
        adminGet<Diagnostics>("/diagnostics").catch(() => null),
        adminGet<OpsOverview>("/ops-overview").catch(() => null),
      ]);
      return { metricsText, diagnostics, opsOverview };
    },
    { intervalMs: 30_000 },
  );

  const d = poll.data;
  const first = poll.loading && !d;
  const failed = !!poll.error && !d;

  const metricsText = d?.metricsText;
  const view = useMemo<HealthView | null>(
    () => (metricsText === undefined ? null : deriveHealthView(metricsText)),
    [metricsText],
  );
  const diag = d?.diagnostics ?? null;

  // 「查看原始 metrics」：直接 <a href> 会丢 Authorization，改走带 token 的 fetch 拿文本，
  // 包成 blob 再新窗口打开；60s 后 revoke（对齐 vanilla）。
  const openRaw = useCallback(async () => {
    try {
      const txt = await adminText("/metrics");
      const blob = new Blob([txt], { type: "text/plain; charset=utf-8" });
      const url = URL.createObjectURL(blob);
      window.open(url, "_blank", "noopener,noreferrer");
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (e) {
      toast(apiErrorMessage(e, "拉取 metrics 失败"), "error");
    }
  }, [toast]);

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="健康面板"
        desc="聚合自 /api/admin/metrics · 30s 刷新"
        actions={
          <>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => poll.refresh()}
              className="gap-1.5"
            >
              <RefreshCw size={14} className={poll.loading ? "animate-spin" : undefined} />
              刷新
            </Button>
            <Button variant="subtle" size="sm" onClick={openRaw} className="gap-1.5">
              <ExternalLink size={14} />
              查看原始 metrics
            </Button>
          </>
        }
      />

      {failed ? (
        <Card className="flex flex-col items-center gap-2 px-6 py-12 text-center">
          <AlertTriangle size={28} className="text-danger" />
          <p className="text-[14px] font-medium text-fg">拉取 /api/admin/metrics 失败</p>
          <p className="max-w-md text-[12.5px] text-faint">{apiErrorMessage(poll.error, "未知错误")}</p>
          <Button variant="secondary" size="sm" onClick={() => poll.refresh()} className="mt-2 gap-1.5">
            <RefreshCw size={14} />
            重试
          </Button>
        </Card>
      ) : (
        <>
          <CurrentActions overview={d?.opsOverview ?? null} loading={first} />
          <SloSection overview={d?.opsOverview ?? null} loading={first} />
          <DiagnosticsSection diag={diag} loading={first} />
          <KpiRow view={view} loading={first} />
          <ChartsSection view={view} loading={first} />
          <TablesSection view={view} loading={first} />
        </>
      )}
    </div>
  );
}

function CurrentActions({ overview, loading }: { overview: OpsOverview | null; loading: boolean }) {
  const actions = overview?.current_actions;
  if (loading) return <div className="h-24 animate-pulse rounded-xl bg-hover" />;
  if (!actions) {
    return (
      <SectionCard title="当前行动" hint="告警与事故的待处理入口">
        <p className="text-[13px] text-muted">行动汇总暂不可用，请分别进入告警和自愈修复查看。</p>
      </SectionCard>
    );
  }
  const active = actions.firing_alerts.length + actions.open_incidents.length;
  return (
    <SectionCard
      title="当前行动"
      hint={active > 0 ? `${active} 项当前需要处理` : "当前没有 firing 告警或 open 事故"}
      bodyClassName="grid grid-cols-1 gap-3 sm:grid-cols-2"
    >
      <a
        href="#tab=alerts"
        className="rounded-lg border border-border p-4 outline-none transition-colors hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring"
      >
        <div className="flex items-center justify-between gap-3">
          <span className="flex items-center gap-2 text-[13px] font-medium text-fg"><BellRing size={16} /> 告警行动队列</span>
          <Badge tone={actions.firing_alerts.length > 0 ? "danger" : "success"}>{actions.firing_alerts.length} firing</Badge>
        </div>
        <p className="mt-2 text-[12px] text-muted">已恢复 {actions.recovered_alerts.length} · 陈旧 {actions.stale_alerts.length} · 查看确认、静默与 runbook</p>
      </a>
      <a
        href="#tab=selfheal"
        className="rounded-lg border border-border p-4 outline-none transition-colors hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring"
      >
        <div className="flex items-center justify-between gap-3">
          <span className="flex items-center gap-2 text-[13px] font-medium text-fg"><Wrench size={16} /> 自愈事故</span>
          <Badge tone={actions.open_incidents.length > 0 ? "danger" : "success"}>{actions.open_incidents.length} open</Badge>
        </div>
        <p className="mt-2 text-[12px] text-muted">查看持续时间、修复状态与完整事件时间线</p>
      </a>
    </SectionCard>
  );
}

function fmtLatencyMs(value: number | null): string {
  return value == null ? "—" : `${Math.round(value).toLocaleString("en-US")} ms`;
}

function SloSection({ overview, loading }: { overview: OpsOverview | null; loading: boolean }) {
  const slo = overview?.slo;
  const entries: Array<[string, SloWindow | undefined]> = [
    ["最近 15 分钟", slo?.windows.last_15m],
    ["最近 1 小时", slo?.windows.last_1h],
    ["最近 24 小时", slo?.windows.last_24h],
  ];
  const sourceLabel = slo?.source === "durable"
    ? "持久化 turn 数据"
    : slo?.source === "since_process_start"
      ? "仅自本进程启动"
      : "不可用";
  return (
    <SectionCard title="Agent Turn SLO" hint={`数据窗口：${sourceLabel}`} bodyClassName="p-0">
      {loading ? (
        <div className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-3">
          {[0, 1, 2].map((i) => <div key={i} className="h-28 animate-pulse rounded-lg bg-hover" />)}
        </div>
      ) : !slo || slo.source === "unavailable" ? (
        <div className="px-4 py-5 text-[13px] text-muted">时间窗口 SLO 暂不可用；不会用进程累计 counter 伪装历史数据。</div>
      ) : (
        <div className="grid grid-cols-1 divide-y divide-border sm:grid-cols-3 sm:divide-x sm:divide-y-0">
          {entries.map(([label, w]) => (
            <div key={label} className="p-4">
              <div className="text-[12px] font-medium text-faint">{label}</div>
              <div className="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="text-[20px] font-semibold tabular-nums text-success">{fmtInt(w?.success ?? 0)} 成功</span>
                <span className={(w?.failure ?? 0) > 0 ? "text-[13px] text-danger" : "text-[13px] text-muted"}>{fmtInt(w?.failure ?? 0)} 失败</span>
              </div>
              <div className="mt-2 text-[12px] leading-relaxed text-muted">
                受影响用户 {fmtInt(w?.affected_users ?? 0)}<br />
                延迟 p50 {fmtLatencyMs(w?.latency_ms.p50 ?? null)} · p95 {fmtLatencyMs(w?.latency_ms.p95 ?? null)}
              </div>
            </div>
          ))}
        </div>
      )}
    </SectionCard>
  );
}

// ── 依赖 / 诊断状态卡矩阵（来自 diagnostics，读真实嵌套形状，修正 vanilla 显示 bug） ──
function DiagnosticsSection({ diag, loading }: { diag: Diagnostics | null; loading: boolean }) {
  return (
    <SectionCard
      title="运维排障快照"
      hint="来自 /api/admin/diagnostics"
      bodyClassName="flex flex-col gap-3"
    >
      {loading ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-[92px] animate-pulse rounded-xl bg-hover" />
          ))}
        </div>
      ) : !diag ? (
        <div className="flex items-center gap-2 rounded-lg bg-warning-soft px-3 py-2.5 text-[13px] text-warning">
          <AlertTriangle size={15} className="shrink-0" />
          /api/admin/diagnostics 加载失败；下方 metrics 仍可查看。
        </div>
      ) : (
        <DiagMatrix diag={diag} />
      )}
      {diag && (
        <details className="text-[12px]">
          <summary className="cursor-pointer select-none text-faint transition-colors hover:text-fg">
            查看原始 diagnostics JSON
          </summary>
          <pre className="mt-2 max-h-80 overflow-auto rounded-lg border border-border bg-hover p-3 font-mono text-[11.5px] leading-relaxed text-muted">
            {JSON.stringify(diag, null, 2)}
          </pre>
        </details>
      )}
    </SectionCard>
  );
}

function DiagMatrix({ diag }: { diag: Diagnostics }) {
  const v = diag.server?.version ?? {};
  const db = diag.db ?? {};
  const rules = diag.alerts?.rules ?? {};
  const outbox = diag.alerts?.outbox ?? {};
  const sev = diag.alerts?.events_24h_by_severity ?? {};
  const ap = diag.account_pool ?? {};

  const waiting = db.pool_waiting ?? 0;
  const firing = rules.firing ?? 0; // ← 真实嵌套 alerts.rules.firing（vanilla 误读 alerts.open ?? alerts.firing）
  const outFailed = outbox.failed ?? 0;
  const outPending = outbox.pending ?? 0;
  const total = ap.total ?? 0;
  const active = ap.active ?? 0; // ← 真实 account_pool.active（vanilla 误读 accountPool.total_active）
  const degraded = (ap.cooldown ?? 0) + (ap.disabled ?? 0) + (ap.banned ?? 0);

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <DiagCard
        icon={Tag}
        label="版本"
        value={v.tag || "unknown"}
        badge={
          <Badge tone="success">在线</Badge>
        }
        hint={`commit ${v.commit || "—"} · built ${v.builtAt || "—"} · node ${diag.server?.node || "—"} · 运行 ${fmtUptime(diag.server?.uptime_sec)}`}
      />
      <DiagCard
        icon={Database}
        label="数据库连接池"
        value={`${db.pool_idle ?? "—"} idle / ${db.pool_total ?? "—"} total`}
        badge={
          waiting > 0 ? <Badge tone="warning">拥塞</Badge> : <Badge tone="success">正常</Badge>
        }
        hint={`等待 ${waiting} · ${pgVersionShort(db.pg_version)}`}
      />
      <DiagCard
        icon={BellRing}
        label="告警"
        value={`${fmtInt(firing)} 触发中`}
        badge={
          firing > 0 ? (
            <Badge tone="danger">触发中</Badge>
          ) : outFailed > 0 ? (
            <Badge tone="warning">投递失败</Badge>
          ) : (
            <Badge tone="success">正常</Badge>
          )
        }
        hint={`outbox 待发 ${outPending} / 失败 ${outFailed} · 24h 严重 ${sev.critical ?? 0}·警告 ${sev.warning ?? 0}·信息 ${sev.info ?? 0}`}
      />
      <DiagCard
        icon={KeyRound}
        label="账号池"
        value={`${fmtInt(active)} / ${fmtInt(total)} 可用`}
        badge={
          active === 0 && total > 0 ? (
            <Badge tone="danger">不可用</Badge>
          ) : degraded > 0 ? (
            <Badge tone="warning">部分降级</Badge>
          ) : (
            <Badge tone="success">正常</Badge>
          )
        }
        hint={`冷却 ${ap.cooldown ?? 0} · 禁用 ${ap.disabled ?? 0} · 封禁 ${ap.banned ?? 0} · 均值 ${Math.round(ap.avg_health ?? 0)}`}
      />
    </div>
  );
}

function DiagCard({
  icon: Icon,
  label,
  value,
  badge,
  hint,
}: {
  icon: typeof Tag;
  label: string;
  value: ReactNode;
  badge: ReactNode;
  hint?: string;
}) {
  return (
    <Card className="flex flex-col gap-2 p-4">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-[12px] font-medium text-faint">
          <Icon size={13} className="shrink-0" />
          {label}
        </span>
        <span className="shrink-0">{badge}</span>
      </div>
      <p
        className="truncate text-[18px] font-semibold leading-tight text-fg tabular-nums"
        title={typeof value === "string" ? value : undefined}
      >
        {value}
      </p>
      {hint && <p className="line-clamp-2 text-[12px] leading-snug text-faint">{hint}</p>}
    </Card>
  );
}

// ── KPI 行（取数同 vanilla _kpiCard） ────────────────────────────────────────
function KpiRow({ view, loading }: { view: HealthView | null; loading: boolean }) {
  const debit = view?.debitByResult ?? {};
  const claude = view?.claudeByStatus ?? {};
  const debitErr = debit.error || 0;
  const debitInsuf = debit.insufficient || 0;
  const claudeErr = claude.error || 0;

  const debitTone: StatTone = debitErr > 0 ? "danger" : debitInsuf > 0 ? "warning" : "success";

  return (
    <StatCardRow>
      <StatCard
        label="HTTP 请求（自本进程启动）"
        value={view ? fmtInt(view.reqTotal) : "—"}
        hint={view ? `OK ${fmtInt(view.okStatusSum)} · 5xx ${fmtInt(view.errStatusSum)}` : undefined}
        tone={view && view.errStatusSum > 0 ? "danger" : "success"}
        icon={Activity}
        loading={loading}
      />
      <StatCard
        label="运行中容器"
        value={view ? fmtInt(view.containersRunning) : "—"}
        hint="agent_containers_running"
        tone="accent"
        icon={Boxes}
        loading={loading}
      />
      <StatCard
        label="计费 success（自本进程启动）"
        value={view ? fmtInt(debit.success || 0) : "—"}
        hint={`insufficient ${fmtInt(debitInsuf)} · error ${fmtInt(debitErr)}`}
        tone={debitTone}
        icon={CreditCard}
        loading={loading}
      />
      <StatCard
        label="Claude success（自本进程启动）"
        value={view ? fmtInt(claude.success || 0) : "—"}
        hint={`error ${fmtInt(claudeErr)}`}
        tone={claudeErr > 0 ? "danger" : "success"}
        icon={Bot}
        loading={loading}
      />
    </StatCardRow>
  );
}

// ── 图表区（口径对齐 vanilla _drawObj*） ─────────────────────────────────────
function ChartsSection({ view, loading }: { view: HealthView | null; loading: boolean }) {
  const statusEntries = view ? positiveEntriesDesc(view.reqByStatus) : [];
  const rejectEntries = view ? positiveEntriesDesc(view.rejectByReason) : [];
  const ttftEntries = view ? positiveEntriesDesc(view.ttftMsByModel) : [];

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <ChartPanel
          title="HTTP 状态码分布"
          hint={view ? `自本进程启动 · 共 ${fmtInt(view.reqTotal)} 请求` : undefined}
          loading={loading}
          empty={statusEntries.length === 0}
          data={statusEntries}
          build={(t) =>
            donutConfig(t, {
              labels: statusEntries.map(([k]) => k),
              data: statusEntries.map(([, v]) => v),
              colorTokens: statusEntries.map(([k]) => statusColorToken(k)),
            })
          }
        />
        <ChartPanel
          title="代理拒绝原因"
          hint="anthropic_proxy_reject"
          loading={loading}
          empty={rejectEntries.length === 0}
          data={rejectEntries}
          build={(t) =>
            barConfig(t, {
              labels: rejectEntries.map(([k]) => k),
              series: [{ label: "拒绝次数", data: rejectEntries.map(([, v]) => v), colorToken: "danger" }],
            })
          }
        />
      </div>
      <ChartPanel
        title="代理延迟 TTFT · 按模型平均 (ms)"
        hint="anthropic_proxy_ttft_seconds"
        loading={loading}
        empty={ttftEntries.length === 0}
        data={ttftEntries}
        build={(t) =>
          barConfig(t, {
            labels: ttftEntries.map(([k]) => k),
            series: [{ label: "TTFT (ms)", data: ttftEntries.map(([, v]) => v) }],
          })
        }
      />
    </div>
  );
}

// ── 图表面板：loading / empty / canvas 分支（对齐 dashboard ChartPanel 惯例） ──
function ChartPanel({
  title,
  hint,
  height = 260,
  loading,
  empty,
  data,
  build,
}: {
  title: string;
  hint?: string;
  height?: number;
  loading?: boolean;
  empty?: boolean;
  data: unknown;
  build: (theme: ChartTheme) => ChartConfiguration;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  // canvas 未挂载（loading/empty）时 useChart 内部因 ref 为空 no-op，不建空 canvas。
  useChart(ref, build, [data, loading, empty]);
  return (
    <ChartCard title={title} hint={hint} height={height}>
      {loading ? (
        <div className="h-full w-full animate-pulse rounded-lg bg-hover" />
      ) : empty ? (
        <div className="flex h-full w-full items-center justify-center text-[13px] text-faint">
          无数据
        </div>
      ) : (
        <canvas ref={ref} />
      )}
    </ChartCard>
  );
}

// ── 表格区（取数对齐 vanilla _renderKvTable / _renderHistTable / 账号池表） ────
function TablesSection({ view, loading }: { view: HealthView | null; loading: boolean }) {
  const auditFail = view?.auditFailByAction ?? {};
  const hasAuditFail = Object.keys(auditFail).length > 0;

  return (
    <div className="flex flex-col gap-4">
      <SectionCard title="HTTP 请求按状态码" hint="自本进程启动累计" bodyClassName="p-0">
        <KvTable obj={view?.reqByStatus ?? {}} keyHeader="status" valHeader="count" loading={loading} />
      </SectionCard>

      <SectionCard title="Anthropic 代理 settle / reject" bodyClassName="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="flex flex-col gap-2">
          <h3 className="text-[12.5px] font-medium text-muted">settle（成功收尾种类）</h3>
          <KvTable obj={view?.settleByKind ?? {}} keyHeader="kind" valHeader="count" loading={loading} />
        </div>
        <div className="flex flex-col gap-2">
          <h3 className="text-[12.5px] font-medium text-muted">reject（拒绝原因）</h3>
          <KvTable obj={view?.rejectByReason ?? {}} keyHeader="reason" valHeader="count" loading={loading} />
        </div>
      </SectionCard>

      <SectionCard
        title="账号池健康"
        hint={view ? `共 ${view.acctRows.length} 个账号` : undefined}
        bodyClassName="p-0"
      >
        <AccountPoolTable rows={view?.acctRows ?? []} loading={loading} />
      </SectionCard>

      <SectionCard title="代理延迟（按模型 / 平均）" bodyClassName="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <h3 className="text-[12.5px] font-medium text-muted">TTFT 首字延迟</h3>
          <HistTable rows={view?.ttftHist ?? []} keyHeader="模型" avgHeader="TTFT 平均" fmtAvg={(h) => fmtMs(h.avg)} loading={loading} />
        </div>
        <div className="flex flex-col gap-2">
          <h3 className="text-[12.5px] font-medium text-muted">流式总时长</h3>
          <HistTable rows={view?.streamHist ?? []} keyHeader="模型" avgHeader="总时长平均" fmtAvg={(h) => fmtMs(h.avg)} loading={loading} />
        </div>
      </SectionCard>

      <SectionCard title="WS Bridge" bodyClassName="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <h3 className="text-[12.5px] font-medium text-muted">缓冲字节（按方向）</h3>
          <HistTable rows={view?.bridgeBufferedHist ?? []} keyHeader="方向" avgHeader="平均" fmtAvg={(h) => fmtKB(h.avg)} loading={loading} />
        </div>
        <div className="flex flex-col gap-2">
          <h3 className="text-[12.5px] font-medium text-muted">会话时长（按结束原因）</h3>
          <HistTable rows={view?.bridgeSessionHist ?? []} keyHeader="原因" avgHeader="平均时长" fmtAvg={(h) => fmtSec(h.avg)} loading={loading} />
        </div>
      </SectionCard>

      {hasAuditFail && (
        <SectionCard
          title="admin_audit 写失败"
          hint="审计落库失败计数（非空即需关注）"
          className="border-warning/40"
          bodyClassName="p-0"
        >
          <KvTable obj={auditFail} keyHeader="action" valHeader="count" loading={loading} />
        </SectionCard>
      )}
    </div>
  );
}

// {k:v} 两列表：按值降序。
function KvTable({
  obj,
  keyHeader,
  valHeader,
  loading,
}: {
  obj: Record<string, number>;
  keyHeader: string;
  valHeader: string;
  loading?: boolean;
}) {
  const rows = useMemo(
    () =>
      Object.entries(obj)
        .map(([k, v]) => ({ k, v }))
        .sort((a, b) => b.v - a.v),
    [obj],
  );
  const columns: Column<{ k: string; v: number }>[] = [
    { key: "k", title: keyHeader, render: (r) => <code className="font-mono text-[12px] text-fg">{r.k}</code> },
    { key: "v", title: valHeader, align: "right", cellClassName: "tabular-nums", render: (r) => fmtInt(r.v) },
  ];
  return (
    <DataTable
      columns={columns}
      rows={rows}
      rowKey={(r) => r.k}
      loading={loading}
      emptyTitle="无数据"
      className="rounded-none border-0"
    />
  );
}

// histogram 表：model / 请求数 / 平均（按 count 降序）。
function HistTable({
  rows,
  keyHeader,
  avgHeader,
  fmtAvg,
  loading,
}: {
  rows: HistRow[];
  keyHeader: string;
  avgHeader: string;
  fmtAvg: (h: HistRow) => string;
  loading?: boolean;
}) {
  const sorted = useMemo(() => [...rows].sort((a, b) => b.count - a.count), [rows]);
  const columns: Column<HistRow>[] = [
    { key: "key", title: keyHeader, render: (h) => <code className="font-mono text-[12px] text-fg">{h.key}</code> },
    { key: "count", title: "请求数", align: "right", cellClassName: "tabular-nums", render: (h) => fmtInt(h.count) },
    { key: "avg", title: avgHeader, align: "right", cellClassName: "tabular-nums", render: (h) => fmtAvg(h) },
  ];
  return (
    <DataTable columns={columns} rows={sorted} rowKey={(h) => h.key} loading={loading} emptyTitle="无数据" />
  );
}

// 账号池健康表：account_id / status(Badge) / health_score（按 health 升序，已在 view 排好）。
const ACCT_TONE: Record<string, "neutral" | "success" | "warning" | "danger"> = {
  active: "success",
  cooldown: "warning",
  disabled: "neutral",
  banned: "danger",
};
function AccountPoolTable({ rows, loading }: { rows: AcctRow[]; loading?: boolean }) {
  const columns: Column<AcctRow>[] = [
    { key: "account_id", title: "account_id", render: (r) => <code className="font-mono text-[12px] text-fg">{r.account_id}</code> },
    {
      key: "status",
      title: "status",
      render: (r) => <Badge tone={ACCT_TONE[r.status] ?? "neutral"}>{r.status}</Badge>,
    },
    {
      key: "health",
      title: "health_score",
      align: "right",
      cellClassName: cn("tabular-nums"),
      render: (r) => r.health.toFixed(0),
    },
  ];
  return (
    <DataTable
      columns={columns}
      rows={rows}
      rowKey={(r) => r.account_id}
      loading={loading}
      emptyTitle="无数据"
      className="rounded-none border-0"
    />
  );
}
