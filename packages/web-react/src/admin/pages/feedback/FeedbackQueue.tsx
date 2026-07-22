import { CheckCircle2, Clock, Inbox, MessageSquare, RefreshCw } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { Alert, Badge, Button } from "../../../components/ui";
import {
  type Column,
  ChartCard,
  DataTable,
  FilterBar,
  SearchInput,
  SelectFilter,
  StatCard,
  StatCardRow,
  TimeAgo,
  donutConfig,
  useChart,
} from "../../components";
import { apiErrorMessage } from "../../lib/adminApi";
import { FeedbackDetailSheet } from "./FeedbackDetailSheet";
import {
  FEEDBACK_STATUS_LABELS,
  FEEDBACK_STATUS_TONE,
  type FeedbackRow,
  type FeedbackStatus,
} from "./types";
import { type FeedbackFilters, useFeedbackQueue } from "./useFeedbackQueue";

const STATUS_OPTIONS: { label: string; value: FeedbackStatus | "" }[] = [
  { label: "全部状态", value: "" },
  { label: "未处理", value: "open" },
  { label: "已确认", value: "acked" },
  { label: "已关闭", value: "closed" },
];

const DAY_MS = 24 * 60 * 60 * 1000;

/** 反馈队列：KPI + 状态构成环图 + 过滤 + 复合游标翻页表；行点开右侧详情抽屉可确认处理。 */
export function FeedbackQueue() {
  const [filters, setFilters] = useState<FeedbackFilters>({ status: "", userId: "" });
  const { rows, loading, loadingMore, error, done, loadMore, refresh, patchRow } =
    useFeedbackQueue(filters);

  const [active, setActive] = useState<FeedbackRow | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);

  const kpi = useMemo(() => {
    const now = Date.now();
    let open = 0;
    let acked = 0;
    let closed = 0;
    let last24h = 0;
    for (const r of rows) {
      if (r.status === "open") open += 1;
      else if (r.status === "acked") acked += 1;
      else if (r.status === "closed") closed += 1;
      const t = new Date(r.created_at).getTime();
      if (!Number.isNaN(t) && now - t <= DAY_MS) last24h += 1;
    }
    return { open, acked, closed, last24h };
  }, [rows]);

  const chartRef = useRef<HTMLCanvasElement>(null);
  useChart(
    chartRef,
    (theme) =>
      donutConfig(theme, {
        labels: ["未处理", "已确认", "已关闭"],
        data: [kpi.open, kpi.acked, kpi.closed],
        colorTokens: ["warning", "success", "muted"],
      }),
    [kpi.open, kpi.acked, kpi.closed],
  );

  const openDetail = (row: FeedbackRow) => {
    setActive(row);
    setSheetOpen(true);
  };

  const columns: Column<FeedbackRow>[] = [
    {
      key: "status",
      title: "状态",
      width: 88,
      render: (r) => (
        <Badge tone={FEEDBACK_STATUS_TONE[r.status]}>{FEEDBACK_STATUS_LABELS[r.status]}</Badge>
      ),
    },
    {
      key: "category",
      title: "分类",
      width: 96,
      render: (r) => <Badge tone="neutral">{r.category}</Badge>,
    },
    {
      key: "user",
      title: "用户",
      width: 150,
      render: (r) =>
        r.user_id ? (
          <span className="truncate">
            {r.username ? `${r.username} ` : ""}
            <span className="font-mono text-[11px] text-faint">#{r.user_id}</span>
          </span>
        ) : (
          <span className="text-faint">匿名</span>
        ),
    },
    {
      key: "description",
      title: "内容摘要",
      render: (r) => (
        <span className="line-clamp-2 max-w-[24rem] text-muted" title={r.description}>
          {r.description}
        </span>
      ),
    },
    {
      key: "version",
      title: "版本",
      width: 90,
      render: (r) => <span className="font-mono text-[11px] text-faint">{r.version || "—"}</span>,
    },
    {
      key: "created_at",
      title: "时间",
      width: 96,
      render: (r) => <TimeAgo value={r.created_at} className="text-[12px] text-muted" />,
    },
  ];

  const totalLabel = `${rows.length}${done ? "" : "+"}`;

  return (
    <div className="flex flex-col gap-4">
      <StatCardRow>
        <StatCard
          label="待处理"
          value={kpi.open}
          icon={Inbox}
          tone={kpi.open > 0 ? "warning" : "success"}
          hint="open（已加载）"
        />
        <StatCard label="已确认" value={kpi.acked} icon={CheckCircle2} tone="success" hint="acked" />
        <StatCard label="24h 新增" value={kpi.last24h} icon={Clock} tone="info" hint="近 24 小时" />
        <StatCard
          label="已加载"
          value={totalLabel}
          icon={MessageSquare}
          tone="neutral"
          hint="当前累积"
        />
      </StatCardRow>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="flex flex-col gap-3">
          <FilterBar>
            <SelectFilter
              label="状态"
              value={filters.status}
              options={STATUS_OPTIONS}
              onChange={(status) => setFilters((f) => ({ ...f, status }))}
            />
            <SearchInput
              value={filters.userId}
              onChange={(userId) => setFilters((f) => ({ ...f, userId }))}
              placeholder="user_id 过滤"
            />
            <Button variant="ghost" size="sm" onClick={refresh} className="gap-1.5">
              <RefreshCw size={14} />
              刷新
            </Button>
          </FilterBar>

          {error ? (
            <Alert tone="danger">加载失败：{apiErrorMessage(error, "加载失败")}</Alert>
          ) : (
            <>
              <DataTable
                columns={columns}
                rows={rows}
                rowKey={(r) => r.id}
                loading={loading}
                onRowClick={openDetail}
                emptyTitle="无反馈"
                emptyHint="当前过滤条件下没有反馈记录。"
              />
              {!done && rows.length > 0 && (
                <div className="flex justify-center">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={loadMore}
                    disabled={loadingMore}
                  >
                    {loadingMore ? "加载中…" : "加载更多"}
                  </Button>
                </div>
              )}
            </>
          )}
        </div>

        <ChartCard title="状态构成" hint="按已加载反馈统计" height={240}>
          {rows.length === 0 ? (
            <div className="flex h-full items-center justify-center text-[12px] text-faint">
              暂无数据
            </div>
          ) : (
            <canvas ref={chartRef} />
          )}
        </ChartCard>
      </div>

      <FeedbackDetailSheet
        key={active?.id ?? "closed"}
        row={active}
        open={sheetOpen}
        onOpenChange={(nextOpen) => {
          setSheetOpen(nextOpen);
          if (!nextOpen) setActive(null);
        }}
        onAcked={patchRow}
      />
    </div>
  );
}
