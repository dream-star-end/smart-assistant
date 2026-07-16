import { CheckCircle2, Percent, RadioTower, RotateCw, XCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { Badge, Button, Input, Modal } from "../../../components/ui";
import {
  type Column,
  CopyChip,
  DataTable,
  FilterBar,
  KeyValue,
  Pagination,
  SelectFilter,
  StatCard,
  StatCardRow,
  TimeAgo,
} from "../../components";
import { adminGet, apiErrorMessage } from "../../lib/adminApi";
import { FormatJsonValue } from "./diff";

const PAGE_SIZE = 50;

/** GET /api/admin/agent-audit 行(与后端 serializeRow 逐字段对齐)。 */
export interface AgentAuditRow {
  id: string;
  user_id: string;
  session_id: string;
  tool: string;
  input_meta: unknown;
  input_hash: string | null;
  output_hash: string | null;
  duration_ms: number | null;
  success: boolean;
  error_msg: string | null;
  created_at: string;
}
interface AuditResp {
  rows: AgentAuditRow[];
  next_before: string | null;
}
type StatsWindow = "1h" | "24h" | "7d";
interface AgentAuditFailureGroup {
  tool: string;
  error_class: string;
  events: number;
  users: number;
  sessions: number;
  p50_ms: number | null;
  p95_ms: number | null;
}
interface AgentAuditToolRate {
  tool: string;
  success_calls: number;
  failure_calls: number;
  total_calls: number;
  failure_rate: number | null;
}
interface AgentAuditStats {
  window: StatsWindow;
  rollup: {
    success_calls: number;
    failure_calls: number;
    total_calls: number;
    failure_rate: number | null;
    tools: AgentAuditToolRate[];
  };
  coverage: {
    scope: "current_online_fleet";
    mode: "best_effort";
    partial: boolean;
    expected_containers: number;
    covered_containers: number;
    started_at: string | null;
    ended_at: string | null;
  };
  failures: {
    events: number;
    affected_users: number;
    groups: AgentAuditFailureGroup[];
  };
}
interface Filter {
  userId: string;
  tool: string;
}

const ERROR_CLASS_LABELS: Record<string, string> = {
  unknown_skill: "未知技能",
  command_not_found: "命令缺失",
  not_executable: "不可执行",
  file_not_found: "文件缺失",
  permission_denied: "权限拒绝",
  edit_conflict: "编辑冲突",
  timeout: "超时",
  cancelled: "已取消",
  validation_error: "参数校验",
  rate_limited: "限流",
  service_unavailable: "服务不可用",
  network_error: "网络错误",
  process_exit: "进程异常退出",
  other: "未细分",
};

const WINDOW_OPTIONS: Array<{ label: string; value: StatsWindow }> = [
  { label: "最近 1 小时", value: "1h" },
  { label: "最近 24 小时", value: "24h" },
  { label: "最近 7 天", value: "7d" },
];

function errorClassTone(errorClass: string): "danger" | "warning" | "neutral" {
  if (["network_error", "service_unavailable", "rate_limited"].includes(errorClass)) {
    return "danger";
  }
  if (errorClass === "cancelled" || errorClass === "other") return "neutral";
  return "warning";
}

function errorClassText(errorClass: string): string {
  return ERROR_CLASS_LABELS[errorClass] ?? errorClass;
}

function formatCount(value: number | undefined): string {
  return value === undefined ? "—" : value.toLocaleString("zh-CN");
}

function formatRate(value: number | null | undefined): string {
  if (value == null) return "—";
  return new Intl.NumberFormat("zh-CN", {
    style: "percent",
    maximumFractionDigits: 2,
  }).format(value);
}

function errorClassOf(row: AgentAuditRow): string {
  if (row.input_meta && typeof row.input_meta === "object" && !Array.isArray(row.input_meta)) {
    const value = (row.input_meta as Record<string, unknown>).error_class;
    if (typeof value === "string" && value.length > 0) return value;
  }
  return "other";
}

function errorClassLabel(row: AgentAuditRow): string {
  return errorClassText(errorClassOf(row));
}

/** 单次工具调用详情:元信息 + input_meta / hash。 */
function DetailBody({ row }: { row: AgentAuditRow }) {
  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-lg border border-border bg-surface px-4 py-2">
        <KeyValue label="工具" value={<Badge tone="accent">{row.tool}</Badge>} />
        <KeyValue
          label="用户"
          value={<span className="font-mono text-[12px]">{row.user_id}</span>}
        />
        <KeyValue
          label="会话"
          value={<span className="font-mono text-[12px] break-all">{row.session_id}</span>}
        />
        <KeyValue
          label="耗时"
          value={
            <span className="tabular-nums">
              {row.duration_ms == null ? "—" : `${row.duration_ms}ms`}
            </span>
          }
        />
        <KeyValue
          label="错误分类"
          value={
            <Badge tone={errorClassTone(errorClassOf(row))}>{errorClassLabel(row)}</Badge>
          }
        />
        <KeyValue
          label="input_hash"
          value={<span className="font-mono text-[12px] break-all">{row.input_hash ?? "—"}</span>}
        />
        <KeyValue
          label="output_hash"
          value={<span className="font-mono text-[12px] break-all">{row.output_hash ?? "—"}</span>}
        />
        <KeyValue label="时间" value={<TimeAgo value={row.created_at} />} />
      </div>
      <div>
        <p className="mb-1.5 text-[12px] font-medium text-faint">input_meta</p>
        <FormatJsonValue value={row.input_meta} />
      </div>
    </div>
  );
}

export function AgentAuditTab() {
  const [filter, setFilter] = useState<Filter>({ userId: "", tool: "" });
  const [statsWindow, setStatsWindow] = useState<StatsWindow>("24h");
  const [dUser, setDUser] = useState("");
  const [dTool, setDTool] = useState("");

  // keyset 分页:cursor = 当前页 before(undefined=首页);history = 已翻过的前序游标(供返回)。
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [history, setHistory] = useState<(string | undefined)[]>([]);
  const [rows, setRows] = useState<AgentAuditRow[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  const [detail, setDetail] = useState<AgentAuditRow | null>(null);
  const [stats, setStats] = useState<AgentAuditStats | null>(null);
  const [statsLoading, setStatsLoading] = useState(true);
  const [statsError, setStatsError] = useState<Error | null>(null);

  // filter/cursor/刷新 变化 → 拉当前页。history 只影响页码显示,不入依赖。
  useEffect(() => {
    void reloadTick;
    let alive = true;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const data = await adminGet<AuditResp>("/agent-audit", {
          limit: PAGE_SIZE,
          user_id: filter.userId,
          tool: filter.tool,
          before: cursor,
        });
        if (!alive) return;
        setRows(data.rows ?? []);
        setNextCursor(data.next_before ?? null);
      } catch (e) {
        if (alive) {
          setError(e instanceof Error ? e : new Error(String(e)));
          setRows([]);
          setNextCursor(null);
        }
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter, cursor, reloadTick]);

  useEffect(() => {
    void reloadTick;
    let alive = true;
    setStatsLoading(true);
    setStatsError(null);
    setStats(null);
    adminGet<AgentAuditStats>("/agent-audit/stats", {
      window: statsWindow,
      user_id: filter.userId,
      tool: filter.tool,
    })
      .then((data) => {
        if (alive) setStats(data);
      })
      .catch((e) => {
        if (!alive) return;
        setStatsError(e instanceof Error ? e : new Error(String(e)));
        setStats(null);
      })
      .finally(() => {
        if (alive) setStatsLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [filter, statsWindow, reloadTick]);

  // 提交新过滤 → 回到首页(cursor=undefined、清空 history)。
  const apply = () => {
    setFilter({ userId: dUser.trim(), tool: dTool.trim() });
    setHistory([]);
    setCursor(undefined);
  };
  const clear = () => {
    setDUser("");
    setDTool("");
    setFilter({ userId: "", tool: "" });
    setHistory([]);
    setCursor(undefined);
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") apply();
  };

  const goNext = () => {
    if (!nextCursor) return;
    setHistory((h) => [...h, cursor]);
    setCursor(nextCursor);
  };
  const goPrev = () => {
    if (history.length === 0) return;
    const prev = history[history.length - 1];
    setHistory((h) => h.slice(0, -1));
    setCursor(prev);
  };

  const columns: Column<AgentAuditRow>[] = [
    {
      key: "user_id",
      title: "用户",
      render: (r) => <CopyChip value={r.user_id} />,
    },
    {
      key: "session_id",
      title: "会话",
      render: (r) => <CopyChip value={r.session_id} />,
    },
    {
      key: "tool",
      title: "工具",
      render: (r) => <Badge tone="accent">{r.tool}</Badge>,
    },
    {
      key: "duration_ms",
      title: "耗时",
      align: "right",
      cellClassName: "tabular-nums text-muted",
      render: (r) => (r.duration_ms == null ? "—" : `${r.duration_ms}ms`),
    },
    {
      key: "error_class",
      title: "错误分类",
      render: (r) => (
        <Badge tone={errorClassTone(errorClassOf(r))}>{errorClassLabel(r)}</Badge>
      ),
    },
    {
      key: "created_at",
      title: "时间",
      render: (r) => <TimeAgo value={r.created_at} />,
    },
  ];

  const toolRateColumns: Column<AgentAuditToolRate>[] = [
    {
      key: "tool",
      title: "工具",
      render: (row) => <Badge tone="accent">{row.tool}</Badge>,
    },
    {
      key: "success_calls",
      title: "成功",
      align: "right",
      cellClassName: "tabular-nums",
      render: (row) => formatCount(row.success_calls),
    },
    {
      key: "failure_calls",
      title: "失败",
      align: "right",
      cellClassName: "tabular-nums",
      render: (row) => formatCount(row.failure_calls),
    },
    {
      key: "failure_rate",
      title: "失败率",
      align: "right",
      cellClassName: "tabular-nums",
      render: (row) => (
        <span className={row.failure_rate && row.failure_rate > 0.05 ? "text-warning" : "text-muted"}>
          {formatRate(row.failure_rate)}
        </span>
      ),
    },
  ];

  const groupColumns: Column<AgentAuditFailureGroup>[] = [
    {
      key: "tool",
      title: "工具",
      render: (group) => <Badge tone="accent">{group.tool}</Badge>,
    },
    {
      key: "error_class",
      title: "错误分类",
      render: (group) => (
        <Badge tone={errorClassTone(group.error_class)}>
          {errorClassText(group.error_class)}
        </Badge>
      ),
    },
    {
      key: "events",
      title: "失败事件",
      align: "right",
      cellClassName: "tabular-nums",
      render: (group) => formatCount(group.events),
    },
    {
      key: "users",
      title: "用户",
      align: "right",
      cellClassName: "tabular-nums text-muted",
      render: (group) => formatCount(group.users),
    },
    {
      key: "sessions",
      title: "会话",
      align: "right",
      cellClassName: "tabular-nums text-muted",
      render: (group) => formatCount(group.sessions),
    },
    {
      key: "latency",
      title: "耗时 P50 / P95",
      align: "right",
      cellClassName: "tabular-nums text-muted",
      render: (group) =>
        group.p50_ms == null || group.p95_ms == null
          ? "—"
          : `${group.p50_ms}ms / ${group.p95_ms}ms`,
    },
  ];

  return (
    <div className="flex flex-col gap-3">
      <FilterBar>
        <SelectFilter
          label="统计窗口"
          value={statsWindow}
          options={WINDOW_OPTIONS}
          onChange={setStatsWindow}
        />
        <Input
          value={dUser}
          onChange={(e) => setDUser(e.target.value)}
          onKeyDown={onKey}
          placeholder="用户 user_id"
          className="h-9 w-full sm:w-44"
        />
        <Input
          value={dTool}
          onChange={(e) => setDTool(e.target.value)}
          onKeyDown={onKey}
          placeholder="工具名(如 Bash)"
          className="h-9 w-full sm:w-48"
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

      <div className="rounded-lg border border-info/40 bg-info-soft px-4 py-3 text-[12.5px] leading-relaxed text-info">
        下方明细只记录失败调用，日志行数不等于平台事故数。成功/失败调用量及比例来自容器侧隐私安全聚合；不采集命令、路径或工具输出原文。覆盖值只描述当前在线 V5 容器，不证明所选历史窗口完整，也不是服务等级协议（SLA）。
      </div>

      <StatCardRow>
        <StatCard
          label="已上报成功调用"
          value={formatCount(stats?.rollup.success_calls)}
          hint={WINDOW_OPTIONS.find((option) => option.value === statsWindow)?.label}
          tone="success"
          icon={CheckCircle2}
          loading={statsLoading && !stats}
        />
        <StatCard
          label="已上报失败调用"
          value={formatCount(stats?.rollup.failure_calls)}
          hint={stats ? `失败明细 ${formatCount(stats.failures.events)} 条` : undefined}
          tone={stats && stats.rollup.failure_calls > 0 ? "warning" : "success"}
          icon={XCircle}
          loading={statsLoading && !stats}
        />
        <StatCard
          label="已上报调用失败率"
          value={formatRate(stats?.rollup.failure_rate)}
          hint={stats ? `样本 ${formatCount(stats.rollup.total_calls)} 次调用` : undefined}
          tone={stats && stats.rollup.failure_calls > 0 ? "warning" : "success"}
          icon={Percent}
          loading={statsLoading && !stats}
        />
        <StatCard
          label="当前在线上报覆盖"
          value={
            stats
              ? `${stats.coverage.covered_containers}/${stats.coverage.expected_containers}`
              : "—"
          }
          hint="当前 V5 在线容器 · 尽力统计"
          tone={stats?.coverage.partial ? "warning" : "success"}
          icon={RadioTower}
          loading={statsLoading && !stats}
        />
      </StatCardRow>

      {stats?.coverage.partial && (
        <div className="rounded-lg border border-warning/40 bg-warning-soft px-4 py-3 text-[12.5px] leading-relaxed text-warning">
          当前在线容器上报覆盖 {stats.coverage.covered_containers}/
          {stats.coverage.expected_containers}；该比例仅基于已上报聚合与心跳，不是服务等级协议（SLA），也不代表历史数据完整覆盖。
        </div>
      )}

      {statsError && (
        <p className="text-sm text-danger">
          统计加载失败：{apiErrorMessage(statsError, "加载失败")}
        </p>
      )}

      <div>
        <h3 className="text-[13px] font-semibold text-fg">按工具成败率</h3>
        <p className="mt-0.5 text-[12px] text-faint">
          成功/失败均来自容器侧聚合上报；失败明细流只含失败,不能直接当失败率看。
        </p>
      </div>

      <DataTable
        columns={toolRateColumns}
        rows={stats?.rollup.tools ?? []}
        rowKey={(row) => row.tool}
        loading={statsLoading && !stats}
        emptyTitle="当前窗口暂无聚合上报"
        emptyHint="容器侧聚合按窗口批量上报,稍后再试。"
      />

      <div className="flex items-end justify-between gap-3">
        <div>
          <h3 className="text-[13px] font-semibold text-fg">失败原因聚合</h3>
          <p className="mt-0.5 text-[12px] text-faint">
            {stats
              ? `${formatCount(stats.failures.events)} 条失败事件 · ${formatCount(stats.failures.affected_users)} 位涉及用户`
              : "按工具与安全错误分类汇总"}
          </p>
        </div>
      </div>

      <DataTable
        columns={groupColumns}
        rows={stats?.failures.groups ?? []}
        rowKey={(group) => `${group.tool}:${group.error_class}`}
        loading={statsLoading && !stats}
        emptyTitle="当前窗口暂无失败聚合"
        emptyHint="没有已上报失败，或当前统计覆盖仍未建立。"
      />

      {error && <p className="text-sm text-danger">加载失败：{apiErrorMessage(error, "加载失败")}</p>}

      <div>
        <h3 className="text-[13px] font-semibold text-fg">失败调用明细</h3>
        <p className="mt-0.5 text-[12px] text-faint">仅失败事件，用于定位具体工具与会话。</p>
      </div>

      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        loading={loading}
        onRowClick={(r) => setDetail(r)}
        emptyTitle="暂无工具失败记录"
        emptyHint="调整过滤条件或稍后再试。"
      />

      <Pagination
        offset={history.length * PAGE_SIZE}
        limit={PAGE_SIZE}
        count={rows.length}
        onChange={(nextOffset) => {
          if (nextOffset > history.length * PAGE_SIZE) goNext();
          else goPrev();
        }}
      />

      <Modal
        open={detail !== null}
        onOpenChange={(o) => !o && setDetail(null)}
        title="工具调用详情"
        className="max-w-2xl"
        footer={
          <Button variant="ghost" onClick={() => setDetail(null)}>
            关闭
          </Button>
        }
      >
        {detail && <DetailBody row={detail} />}
      </Modal>
    </div>
  );
}
