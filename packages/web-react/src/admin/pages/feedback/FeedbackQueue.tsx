import { CheckCircle2, Inbox, MessageSquare, RefreshCw } from "lucide-react";
import { useRef, useState } from "react";
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
const TRAFFIC_OPTIONS = [
  { label: "真实用户", value: "production_user" },
  { label: "匿名反馈", value: "anonymous" },
  { label: "历史口径不可用", value: "legacy_unavailable" },
  { label: "全部流量", value: "all" },
  { label: "内部管理员", value: "internal_admin" },
  { label: "合成灰度", value: "synthetic_canary" },
  { label: "E2E", value: "e2e" },
];

function trafficLabel(value: FeedbackRow["traffic_class"]): string {
  if (value === "production_user") return "真实用户";
  if (value === "anonymous") return "匿名";
  if (value === "legacy_unavailable") return "历史不可用";
  return value;
}

/** 反馈队列：KPI + 状态构成环图 + 过滤 + 复合游标翻页表；行点开右侧详情抽屉可确认处理。 */
export function FeedbackQueue() {
  const [filters, setFilters] = useState<FeedbackFilters>({
    status: "",
    userId: "",
    trafficClass: "production_user",
  });
  const { rows, totals, loading, loadingMore, error, done, loadMore, refresh, patchRow } =
    useFeedbackQueue(filters);

  const [active, setActive] = useState<FeedbackRow | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);

  const kpi = totals?.by_status ?? { open: 0, acked: 0, closed: 0 };

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
      key: "traffic_class",
      title: "流量",
      width: 92,
      render: (r) => (
        <Badge tone={r.traffic_class === "production_user" ? "success" : "neutral"}>
          {trafficLabel(r.traffic_class)}
        </Badge>
      ),
    },
    {
      key: "priority",
      title: "优先级",
      width: 76,
      render: (r) => r.priority ? (
        <Badge tone={r.priority === "urgent" ? "danger" : r.priority === "high" ? "warning" : "neutral"}>
          {{ low: "低", normal: "普通", high: "高", urgent: "紧急" }[r.priority]}
        </Badge>
      ) : <span className="text-faint">未设置</span>,
    },
    {
      key: "assigned_to",
      title: "负责人",
      width: 88,
      render: (r) => r.assigned_to ? <span className="font-mono text-[11px]">#{r.assigned_to}</span> : <span className="text-faint">未指派</span>,
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

  return (
    <div className="flex flex-col gap-4">
      <StatCardRow>
        <StatCard
          label="待处理"
          value={kpi.open}
          icon={Inbox}
          tone={kpi.open > 0 ? "warning" : "success"}
          hint="服务端全量"
        />
        <StatCard label="已确认" value={kpi.acked} icon={CheckCircle2} tone="success" hint="服务端全量" />
        <StatCard label="已关闭" value={kpi.closed} icon={CheckCircle2} tone="neutral" hint="服务端全量" />
        <StatCard
          label="反馈总数"
          value={totals?.total ?? 0}
          icon={MessageSquare}
          tone="neutral"
          hint={`当前列表已加载 ${rows.length} 条`}
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
            <SelectFilter
              label="流量"
              value={filters.trafficClass}
              options={TRAFFIC_OPTIONS}
              onChange={(trafficClass) => setFilters((f) => ({ ...f, trafficClass }))}
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

        <ChartCard title="状态构成" hint="按当前筛选的服务端全量统计" height={240}>
          {(totals?.total ?? 0) === 0 ? (
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
        onUpdated={(updated) => {
          patchRow(updated);
          refresh();
        }}
      />
    </div>
  );
}
