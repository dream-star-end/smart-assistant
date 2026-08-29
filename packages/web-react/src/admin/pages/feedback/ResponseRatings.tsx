import { Link2, MessageSquare, ThumbsDown, ThumbsUp, TrendingUp, Users } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Badge, Button } from "../../../components/ui";
import {
  type Column,
  ChartCard,
  CopyChip,
  DataTable,
  FilterBar,
  SectionCard,
  SelectFilter,
  StatCard,
  StatCardRow,
  TimeAgo,
  donutConfig,
  useChart,
} from "../../components";
import { adminGet, apiErrorMessage } from "../../lib/adminApi";
import type {
  DownRatingRow,
  ModelRatingStat,
  RatingBucket,
  ResponseRatingStats,
  ResponseRatingsResp,
} from "./types";

const PAGE_SIZE = 50;
type DownRatingSource = "explicit" | "implicit" | "all";

function pct(rate: number | null): string {
  return rate === null ? "—" : `${(rate * 100).toFixed(1)}%`;
}

function rateConclusion(bucket: RatingBucket | undefined): string {
  if (!bucket || bucket.sample_note === "no_sample") return "暂无样本";
  if (bucket.sample_note === "small_sample") return `样本不足（n=${bucket.total}）`;
  return pct(bucket.up_rate);
}

/** 好评率 → 语义色：≥90% 绿，≥70% 黄，其余红；无样本灰。 */
function rateTone(
  rate: number | null,
  sampleNote?: "no_sample" | "small_sample" | "observed",
): "success" | "warning" | "danger" | "neutral" {
  if (rate === null || sampleNote === "small_sample" || sampleNote === "no_sample") return "neutral";
  if (rate >= 0.9) return "success";
  if (rate >= 0.7) return "warning";
  return "danger";
}

function interval(bucket: RatingBucket | undefined): string {
  if (!bucket || bucket.ci95_low === null || bucket.ci95_high === null) return "无可用区间";
  return `95% CI ${pct(bucket.ci95_low)}–${pct(bucket.ci95_high)}${
    bucket.sample_note === "small_sample" ? " · 样本较少" : ""
  }`;
}

/**
 * 响应评分卡：👍/👎 构成（overall / 7d / 30d）+ 分模型好评率 + 最近差评明细（游标翻页）。
 * 读 GET /api/admin/response-ratings 的 { stats, down_ratings } 形状。差评带 trace_id 供反查。
 */
export function ResponseRatings() {
  const [stats, setStats] = useState<ResponseRatingStats | null>(null);
  const [downRows, setDownRows] = useState<DownRatingRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const cursorRef = useRef<{ createdAt: string | null; id: string | null }>({
    createdAt: null,
    id: null,
  });
  const [done, setDone] = useState(false);
  const [source, setSource] = useState<DownRatingSource>("explicit");
  const [traffic, setTraffic] = useState("production_user");
  const requestSeqRef = useRef(0);

  const fetchPage = useCallback(async (isFirst: boolean) => {
    const requestSeq = isFirst ? ++requestSeqRef.current : requestSeqRef.current;
    if (isFirst) {
      cursorRef.current = { createdAt: null, id: null };
      setDownRows([]);
      setDone(false);
      setLoading(true);
      setError(null);
    } else {
      setLoadingMore(true);
    }
    try {
      const resp = await adminGet<ResponseRatingsResp>("/response-ratings", {
        limit: PAGE_SIZE,
        before_created_at: isFirst ? undefined : cursorRef.current.createdAt,
        before_id: isFirst ? undefined : cursorRef.current.id,
        source,
        traffic_class: traffic,
      });
      if (requestSeq !== requestSeqRef.current) return;
      if (isFirst) setStats(resp.stats);
      const d = resp.down_ratings;
      cursorRef.current = { createdAt: d.next_before_created_at, id: d.next_before_id };
      setDone(!d.next_before_created_at || !d.next_before_id);
      setDownRows((prev) => (isFirst ? d.rows : [...prev, ...d.rows]));
    } catch (e) {
      if (requestSeq !== requestSeqRef.current) return;
      setError(e instanceof Error ? e : new Error(String(e)));
    } finally {
      if (requestSeq === requestSeqRef.current) {
        setLoading(false);
        setLoadingMore(false);
      }
    }
  }, [source, traffic]);

  useEffect(() => {
    void fetchPage(true);
  }, [fetchPage]);

  const overall = stats?.overall;
  const chartRef = useRef<HTMLCanvasElement>(null);
  useChart(
    chartRef,
    (theme) =>
      donutConfig(theme, {
        labels: ["好评", "差评"],
        data: [overall?.up ?? 0, overall?.down ?? 0],
        colorTokens: ["success", "danger"],
      }),
    [overall?.up, overall?.down],
  );

  const modelColumns: Column<ModelRatingStat>[] = [
    {
      key: "model",
      title: "模型",
      render: (m) => (
        <span className="font-mono text-[12px] text-fg">{m.model ?? "（未标注）"}</span>
      ),
    },
    {
      key: "up",
      title: "好评",
      align: "right",
      width: 72,
      cellClassName: "tabular-nums",
      render: (m) => m.up,
    },
    {
      key: "down",
      title: "差评",
      align: "right",
      width: 72,
      cellClassName: "tabular-nums",
      render: (m) => m.down,
    },
    {
      key: "up_rate",
      title: "好评率",
      align: "right",
      width: 96,
      render: (m) => (
        <Badge tone={rateTone(m.up_rate, m.sample_note)} title={interval(m)}>
          {pct(m.up_rate)}
          {m.sample_note === "small_sample" ? " · 样本少" : ""}
        </Badge>
      ),
    },
  ];

  const downColumns: Column<DownRatingRow>[] = [
    {
      key: "model",
      title: "模型",
      width: 130,
      render: (r) => (
        <span className="font-mono text-[11px] text-muted">{r.model ?? "—"}</span>
      ),
    },
    {
      key: "comment",
      title: "评论 / 标签",
      render: (r) => (
        <div className="min-w-0">
          {r.comment ? (
            <span className="line-clamp-2 max-w-[26rem] text-muted" title={r.comment}>
              {r.comment}
            </span>
          ) : (
            <span className="text-faint">（无评论）</span>
          )}
          {r.tags.length > 0 && (
            <div className="mt-1 flex flex-wrap gap-1">
              {r.tags.map((t) => (
                <Badge key={t} tone="neutral">
                  {t}
                </Badge>
              ))}
            </div>
          )}
        </div>
      ),
    },
    {
      key: "username",
      title: "用户",
      width: 120,
      render: (r) => <span className="truncate text-[12px] text-muted">{r.username ?? "—"}</span>,
    },
    {
      key: "traffic_class",
      title: "流量",
      width: 88,
      render: (r) => (
        <Badge tone={r.traffic_class === "production_user" ? "success" : "neutral"}>
          {r.traffic_class === "production_user" ? "真实用户" : r.traffic_class}
        </Badge>
      ),
    },
    {
      key: "trace_id",
      title: "trace",
      width: 130,
      render: (r) =>
        r.trace_id ? (
          <CopyChip value={r.trace_id} label={`${r.trace_id.slice(0, 8)}…`} />
        ) : (
          <span className="text-faint">—</span>
        ),
    },
    {
      key: "created_at",
      title: "时间",
      width: 96,
      render: (r) => <TimeAgo value={r.created_at} className="text-[12px] text-muted" />,
    },
  ];

  if (error) {
    return <Alert tone="danger">加载评分统计失败：{apiErrorMessage(error, "加载失败")}</Alert>;
  }

  return (
    <div className="flex flex-col gap-4">
      <FilterBar>
        <SelectFilter
          label="流量"
          value={traffic}
          options={[
            { label: "真实用户", value: "production_user" },
            { label: "全部流量", value: "all" },
            { label: "内部管理员", value: "internal_admin" },
            { label: "合成灰度", value: "synthetic_canary" },
            { label: "E2E", value: "e2e" },
          ]}
          onChange={setTraffic}
        />
      </FilterBar>
      <StatCardRow>
        <StatCard
          label="30 天显式样本"
          value={stats?.last_30d.total ?? 0}
          icon={MessageSquare}
          tone="neutral"
          hint={`${stats?.completed_turns.last_30d ?? 0} 个完成 turn`}
          loading={loading}
        />
        <StatCard
          label="30 天显式覆盖率"
          value={loading ? "…" : pct(stats?.explicit_coverage.last_30d ?? null)}
          icon={TrendingUp}
          tone="neutral"
          hint="评分数 / 完成 turn"
          loading={loading}
        />
        <StatCard
          label="评分用户"
          value={stats?.rating_users ?? 0}
          icon={Users}
          tone="neutral"
          hint="去重用户数"
          loading={loading}
        />
        <StatCard
          label="Trace 完整率"
          value={loading ? "…" : pct(
            stats?.trace_completeness && stats.trace_completeness.total > 0
              ? stats.trace_completeness.with_trace / stats.trace_completeness.total
              : null,
          )}
          icon={Link2}
          tone="neutral"
          hint={`${stats?.trace_completeness?.with_trace ?? 0} / ${stats?.trace_completeness?.total ?? 0} 条可追踪`}
          loading={loading}
        />
      </StatCardRow>
      <StatCardRow>
        <StatCard
          label="总体好评率结论"
          value={loading ? "…" : rateConclusion(overall)}
          icon={TrendingUp}
          tone={rateTone(overall?.up_rate ?? null, overall?.sample_note)}
          hint={overall ? `${pct(overall.up_rate)} · ${interval(overall)}` : "加载中"}
          loading={loading}
        />
        <StatCard
          label="好评"
          value={overall?.up ?? 0}
          icon={ThumbsUp}
          tone="success"
          loading={loading}
        />
        <StatCard
          label="差评"
          value={overall?.down ?? 0}
          icon={ThumbsDown}
          tone={((overall?.down ?? 0) > 0 ? "danger" : "neutral") as "danger" | "neutral"}
          loading={loading}
        />
        <StatCard
          label="30 天隐式弱信号"
          value={
            loading
              ? "…"
              : stats?.implicit_per_100_completed_turns.last_30d == null
                ? "—"
                : `${stats.implicit_per_100_completed_turns.last_30d}/百 turn`
          }
          icon={ThumbsDown}
          tone="neutral"
          hint="不计入好评率，仅用于辅助判断"
          loading={loading}
        />
      </StatCardRow>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
        <ChartCard title="好评 / 差评构成" hint="全部时间" height={240}>
          {(overall?.total ?? 0) === 0 ? (
            <div className="flex h-full items-center justify-center text-[12px] text-faint">
              暂无评分
            </div>
          ) : (
            <canvas ref={chartRef} />
          )}
        </ChartCard>

        <SectionCard title="分模型好评率" hint="按评分总量降序" bodyClassName="px-0 py-0">
          <DataTable
            columns={modelColumns}
            rows={stats?.by_model ?? []}
            rowKey={(m) => m.model ?? "__null__"}
            loading={loading}
            className="rounded-none border-0"
            emptyTitle="暂无评分"
          />
        </SectionCard>
      </div>

      <SectionCard
        title="最近差评"
        hint={
          source === "explicit"
            ? "用户主动点踩，可复制 trace_id 反查全链路"
            : source === "implicit"
              ? "中途打断、改写重发等行为弱信号"
              : "显式点踩与行为弱信号"
        }
        action={
          <select
            aria-label="差评来源"
            value={source}
            onChange={(event) => {
              requestSeqRef.current += 1;
              setSource(event.target.value as DownRatingSource);
            }}
            className="h-8 rounded-md border border-border bg-surface px-2.5 text-[12px] text-fg outline-none focus:border-accent focus:ring-2 focus:ring-ring"
          >
            <option value="explicit">用户主动点踩</option>
            <option value="implicit">行为弱信号</option>
            <option value="all">全部差评</option>
          </select>
        }
        bodyClassName="px-0 py-0"
      >
        <DataTable
          columns={downColumns}
          rows={downRows}
          rowKey={(r) => r.id}
          loading={loading}
          className="rounded-none border-0"
          emptyTitle="暂无差评"
          emptyHint="没有收到差评，继续保持。"
        />
        {!done && downRows.length > 0 && (
          <div className="flex justify-center border-t border-border py-3">
            <Button variant="secondary" size="sm" onClick={() => fetchPage(false)} disabled={loadingMore}>
              {loadingMore ? "加载中…" : "加载更多"}
            </Button>
          </div>
        )}
      </SectionCard>
    </div>
  );
}
