import { useCallback, useEffect, useRef, useState } from "react";
import { ChartCard, barConfig, chartNum, donutConfig, lineConfig, useChart } from "../charts";
import { api, apiErrorMessage } from "../../lib/api";
import type {
  AuthSession,
  UsageReport,
  UsageReportModel,
  UsageReportWindow,
  UsageResponse,
  UsageSessionRow,
} from "../../lib/types";
import { cn, formatCompactCount, formatCredits, groupDigits } from "../../lib/utils";
import { agentDisplayName } from "../chat/agentNames";
import { useProjectScope } from "../../hooks/useProjectScope";
import { Alert, Button, Progress, ProjectScopeSelect, Skeleton, Spinner, Tabs } from "../ui";
import { formatReportBucket, REPORT_WINDOW_NOUN, shortTime } from "./labels";

function boardProjectQuery(kind: string, workId: string | undefined): string | undefined {
  if (kind === "ungrouped") return "none";
  if (kind === "work" && workId) return workId;
  return undefined;
}

const SESSIONS_PAGE = 20;

/** 图表区窗口口径（默认 7d，作用于 stat 卡 + 全部图表）。 */
const WINDOWS: { value: UsageReportWindow; label: string }[] = [
  { value: "24h", label: "24 小时" },
  { value: "7d", label: "7 天" },
  { value: "30d", label: "30 天" },
];

const VIEWS: { value: "overview" | "by-model"; label: string }[] = [
  { value: "overview", label: "总览" },
  { value: "by-model", label: "按模型" },
];

/** 安全求和字符串大数（BigInt 精确，非法项跳过）。 */
function sumBig(...vals: string[]): string {
  let acc = 0n;
  for (const v of vals) {
    if (/^-?\d+$/.test(v)) {
      try {
        acc += BigInt(v);
      } catch {
        /* skip */
      }
    }
  }
  return acc.toString();
}

/**
 * 按模型积分降序取前 5，其余合并为「其他」。**绘图数值化在此收口**（chartNum，非计费
 * 权威）。导出供单测覆盖 top5 + 合并逻辑。返回空数组时调用方显示空态、不画空图。
 */
export function topModelsWithOther(
  models: readonly UsageReportModel[],
  topN = 5,
): { label: string; credits: number }[] {
  const sorted = [...models]
    .map((m) => ({ label: m.model, credits: chartNum(m.credits) }))
    .sort((a, b) => b.credits - a.credits);
  if (sorted.length <= topN) return sorted.filter((s) => s.credits > 0);
  const head = sorted.slice(0, topN);
  const otherSum = sorted.slice(topN).reduce((acc, m) => acc + m.credits, 0);
  const out = head.filter((s) => s.credits > 0);
  if (otherSum > 0) out.push({ label: "其他", credits: otherSum });
  return out;
}

/**
 * 用量统计 Tab：
 *  - 顶部窗口切换 pill（24h/7d/30d，默认 7d）作用于下面整个图表区（来自 getMyUsageReport）；
 *  - 4 张窗口口径 Stat 卡 + 图表 grid（积分趋势面积图 / 请求柱状 / 按模型环图 / Token 构成环图）；
 *  - 缓存命中率 + 节省 + 累计口径小 stat 保留（全生命周期，来自 getUsage）；
 *  - 会话维度明细（含组队归组）原样保留。
 * 所有大数字段全程字符串（formatCompactCount / formatCredits / groupDigits）；
 * 唯图表 dataset 经 chartNum 收口数值化。
 */
export function UsageTab({ auth }: { auth: AuthSession }) {
  const { scope } = useProjectScope();
  const boardProjectId = boardProjectQuery(scope.kind, scope.workProject?.id);
  // 全生命周期口径（缓存 / 节省 / 会话明细 / 累计）。
  const [data, setData] = useState<UsageResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [sessions, setSessions] = useState<UsageSessionRow[]>([]);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [usageReloadTick, setUsageReloadTick] = useState(0);
  const [usageView, setUsageView] = useState<"overview" | "by-model">("overview");
  /** 展开了组队明细的会话行(session_id 集合)。 */
  const [expandedDelegates, setExpandedDelegates] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );

  // 窗口口径图表（默认 7d）。
  const [window, setWindow] = useState<UsageReportWindow>("7d");
  const [report, setReport] = useState<UsageReport | null>(null);
  const [reportLoading, setReportLoading] = useState(true);
  const [reportErr, setReportErr] = useState<string | null>(null);
  /** 重试计数：+1 触发窗口口径重拉（不改 window 也能重试）。 */
  const [reportReloadTick, setReportReloadTick] = useState(0);

  const toggleDelegates = useCallback((sessionId: string) => {
    setExpandedDelegates((prev) => {
      const next = new Set(prev);
      if (next.has(sessionId)) next.delete(sessionId);
      else next.add(sessionId);
      return next;
    });
  }, []);

  // 全生命周期：首屏拉一次（会话首页 + 摘要 + 缓存 + 节省）。
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setErr(null);
    api
      .getUsage(auth, { sessionsLimit: SESSIONS_PAGE, boardProjectId })
      .then((u) => {
        if (!alive) return;
        setData(u);
        setSessions(u.sessions.rows);
        setOffset(u.sessions.rows.length);
        setHasMore(u.sessions.has_more);
      })
      .catch((e) => {
        if (alive) setErr(apiErrorMessage(e, "加载用量统计失败"));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [auth, usageReloadTick, boardProjectId]);

  // 窗口口径：window 切换或重试即重拉。切窗口先清 report 显 Skeleton。
  useEffect(() => {
    let alive = true;
    setReportLoading(true);
    setReportErr(null);
    setReport(null);
    api
      .getMyUsageReport(auth, window, { boardProjectId })
      .then((r) => {
        if (alive) setReport(r);
      })
      .catch((e) => {
        if (alive) setReportErr(apiErrorMessage(e, "加载图表数据失败"));
      })
      .finally(() => {
        if (alive) setReportLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [auth, window, reportReloadTick, boardProjectId]);

  const loadMore = useCallback(async () => {
    if (!hasMore || loadingMore) return;
    setLoadingMore(true);
    try {
      const u = await api.getUsage(auth, {
        sessionsLimit: SESSIONS_PAGE,
        sessionsOffset: offset,
        boardProjectId,
      });
      setSessions((prev) => [...prev, ...u.sessions.rows]);
      setOffset((o) => o + u.sessions.rows.length);
      setHasMore(u.sessions.has_more);
    } catch (e) {
      setErr(apiErrorMessage(e, "加载更多失败"));
    } finally {
      setLoadingMore(false);
    }
  }, [auth, hasMore, loadingMore, offset, boardProjectId]);

  // ── 图表数据（report 存在时才有值；null 时 canvas 不挂载，useChart 自 no-op） ──
  const rs = report?.summary ?? null;
  const trendLabels = report ? report.trend.map((p) => formatReportBucket(p.bucket, window)) : [];
  const creditTrend = report ? report.trend.map((p) => chartNum(p.credits)) : [];
  const requestTrend = report ? report.trend.map((p) => chartNum(p.requests)) : [];
  const modelSlices = report ? topModelsWithOther(report.models) : [];
  const windowTokenTotal = rs
    ? sumBig(rs.input_tokens, rs.output_tokens, rs.cache_read_tokens, rs.cache_write_tokens)
    : "0";
  // 两个首屏请求都完成后 canvas 才会挂载；把这个可见性边沿纳入图表 effect 依赖，
  // 避免 report 先返回时 useChart 因 ref=null no-op，随后仅 loading 变化却永不重画。
  const chartReady = !loading && !reportLoading && report !== null;

  const creditRef = useRef<HTMLCanvasElement>(null);
  const requestRef = useRef<HTMLCanvasElement>(null);
  const modelRef = useRef<HTMLCanvasElement>(null);
  const tokenRef = useRef<HTMLCanvasElement>(null);

  useChart(
    creditRef,
    (theme) =>
      lineConfig(theme, {
        labels: trendLabels,
        series: [{ label: "积分消耗", data: creditTrend, colorToken: "accent", fill: true }],
      }),
    [report, window, chartReady],
  );
  useChart(
    requestRef,
    (theme) =>
      barConfig(theme, {
        labels: trendLabels,
        series: [{ label: "请求次数", data: requestTrend, colorToken: "info" }],
      }),
    [report, window, chartReady],
  );
  useChart(
    modelRef,
    (theme) =>
      donutConfig(theme, {
        labels: modelSlices.map((m) => m.label),
        data: modelSlices.map((m) => m.credits),
        legend: "bottom",
      }),
    [report, window, chartReady],
  );
  useChart(
    tokenRef,
    (theme) =>
      donutConfig(theme, {
        labels: ["输入", "输出", "缓存命中", "缓存写入"],
        data: rs
          ? [
              chartNum(rs.input_tokens),
              chartNum(rs.output_tokens),
              chartNum(rs.cache_read_tokens),
              chartNum(rs.cache_write_tokens),
            ]
          : [],
        colorTokens: ["accent", "info", "success", "warning"],
        legend: "bottom",
      }),
    [report, window, chartReady],
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 py-16 text-[13px] text-faint">
        <Spinner /> 加载用量统计…
      </div>
    );
  }
  if (err) {
    return (
      <div className="px-5 py-4">
        <Alert tone="danger" className="text-[12.5px]">
          {err}
        </Alert>
        <Button
          size="sm"
          variant="secondary"
          className="mt-2"
          onClick={() => setUsageReloadTick((tick) => tick + 1)}
        >
          重试
        </Button>
      </div>
    );
  }
  if (!data) return null;

  const s = data.summary;
  const hitPct = data.cache.hit_rate != null ? Math.round(data.cache.hit_rate * 1000) / 10 : null;
  const modelHasData = modelSlices.length > 0;
  const tokenHasData = windowTokenTotal !== "0";

  return (
    <div className="flex flex-col">
      {/* 视图 + 窗口切换 pill（作用于下面整个图表区 / 按模型表） */}
      <div className="flex items-center justify-between gap-3 px-5 pt-4">
        <div className="min-w-0">
          <div className="text-[11px] font-medium uppercase tracking-wide text-faint">
            {usageView === "overview" ? "用量总览" : "按模型统计"} · 近 {REPORT_WINDOW_NOUN[window]}
          </div>
          <p className="mt-1 text-caption text-muted">
            按运行时项目归属 / 迁移回填。会话后来移动不会改写已入账行；delegate 归入父会话项目。
          </p>
        </div>
        <div className="flex min-w-0 items-center gap-2 overflow-x-auto">
          <ProjectScopeSelect className="w-40 shrink-0" />
          <Tabs
            aria-label="用量视图"
            value={usageView}
            onValueChange={(v) => setUsageView(v as "overview" | "by-model")}
            items={VIEWS}
          />
          <Tabs
            aria-label="统计窗口"
            value={window}
            onValueChange={(v) => setWindow(v as UsageReportWindow)}
            items={WINDOWS}
          />
        </div>
      </div>

      {reportLoading ? (
        <div className="px-5 py-4">
          <div className="grid grid-cols-2 gap-2">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-[58px] rounded-xl" />
            ))}
          </div>
          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-[220px] rounded-xl" />
            ))}
          </div>
        </div>
      ) : reportErr ? (
        <div className="px-5 py-4">
          <Alert tone="danger" className="text-[12.5px]">
            {reportErr}
          </Alert>
          <button
            type="button"
            onClick={() => setReportReloadTick((t) => t + 1)}
            className="mt-2 text-[13px] text-muted outline-none hover:text-fg focus-visible:ring-2 focus-visible:ring-ring"
          >
            重试
          </button>
        </div>
      ) : (
        report && rs && (
          <>
            {/* 窗口口径 4 张 Stat 卡 */}
            <div className="grid grid-cols-2 gap-2 px-5 py-4">
              <Stat label={`请求数 · 近${REPORT_WINDOW_NOUN[window]}`} value={groupDigits(rs.requests)} />
              <Stat
                label={`消耗积分 · 近${REPORT_WINDOW_NOUN[window]}`}
                value={`${formatCredits(rs.credits)} 积分`}
                accent
              />
              <Stat label={`输入 token · 近${REPORT_WINDOW_NOUN[window]}`} value={formatCompactCount(rs.input_tokens)} />
              <Stat label={`输出 token · 近${REPORT_WINDOW_NOUN[window]}`} value={formatCompactCount(rs.output_tokens)} />
            </div>

            {usageView === "by-model" ? (
            <div className="px-5 pb-4">
              {report.models.length === 0 ? (
                <p className="py-8 text-center text-[12.5px] text-faint">该时段暂无模型用量。</p>
              ) : (
                <div className="overflow-x-auto rounded-xl border border-border">
                  <table className="w-full min-w-[40rem] text-left text-[12.5px]">
                    <caption className="sr-only">
                      {`按模型用量，近 ${REPORT_WINDOW_NOUN[window]}`}
                    </caption>
                    <thead className="bg-hover text-[11px] font-medium uppercase tracking-wide text-faint">
                      <tr>
                        <th className="px-3 py-2">模型</th>
                        <th className="px-3 py-2 text-right">请求</th>
                        <th className="px-3 py-2 text-right">输入</th>
                        <th className="px-3 py-2 text-right">输出</th>
                        <th className="px-3 py-2 text-right">缓存命中</th>
                        <th className="px-3 py-2 text-right">缓存写入</th>
                        <th className="px-3 py-2 text-right">积分</th>
                      </tr>
                    </thead>
                    <tbody>
                      {report.models.map((model) => (
                        <tr key={model.model} className="border-t border-border">
                          <td className="px-3 py-2 font-mono text-fg">{model.model}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{groupDigits(model.requests)}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{formatCompactCount(model.input_tokens)}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{formatCompactCount(model.output_tokens)}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{formatCompactCount(model.cache_read_tokens)}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{formatCompactCount(model.cache_write_tokens)}</td>
                          <td className="px-3 py-2 text-right tabular-nums font-medium">{formatCredits(model.credits)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
            ) : (
            <div className="grid grid-cols-1 gap-3 px-5 pb-4 sm:grid-cols-2">
              <ChartCard
                title="积分消耗趋势"
                hint={`近 ${REPORT_WINDOW_NOUN[window]}`}
                height={200}
                ariaLabel={`积分消耗趋势，近 ${REPORT_WINDOW_NOUN[window]}`}
                dataTable={{
                  columns: ["时间", "消耗积分"],
                  rows: report.trend.map((point, index) => [
                    trendLabels[index],
                    `${formatCredits(point.credits)} 积分`,
                  ]),
                  emptyText: "该时段暂无积分消耗数据。",
                }}
              >
                <canvas ref={creditRef} />
              </ChartCard>
              <ChartCard
                title="请求次数"
                hint={`近 ${REPORT_WINDOW_NOUN[window]}`}
                height={200}
                ariaLabel={`请求次数趋势，近 ${REPORT_WINDOW_NOUN[window]}`}
                dataTable={{
                  columns: ["时间", "请求次数"],
                  rows: report.trend.map((point, index) => [
                    trendLabels[index],
                    groupDigits(point.requests),
                  ]),
                  emptyText: "该时段暂无请求数据。",
                }}
              >
                <canvas ref={requestRef} />
              </ChartCard>
              <ChartCard
                title="按模型积分构成"
                hint="扣费前 5 · 余并「其他」"
                height={220}
                ariaLabel={`按模型积分构成，近 ${REPORT_WINDOW_NOUN[window]}`}
                dataTable={{
                  columns: ["模型", "消耗积分"],
                  rows: report.models.map((model) => [
                    model.model,
                    `${formatCredits(model.credits)} 积分`,
                  ]),
                  emptyText: "该时段暂无模型用量。",
                }}
              >
                {modelHasData ? (
                  <canvas ref={modelRef} />
                ) : (
                  <div className="flex h-full items-center justify-center text-[12.5px] text-faint">
                    该时段暂无模型用量。
                  </div>
                )}
              </ChartCard>
              <ChartCard
                title="Token 构成"
                hint={`近 ${REPORT_WINDOW_NOUN[window]}`}
                height={220}
                ariaLabel={`Token 构成，近 ${REPORT_WINDOW_NOUN[window]}`}
                dataTable={{
                  columns: ["类型", "Token 数"],
                  rows: [
                    ["输入", groupDigits(rs.input_tokens)],
                    ["输出", groupDigits(rs.output_tokens)],
                    ["缓存命中", groupDigits(rs.cache_read_tokens)],
                    ["缓存写入", groupDigits(rs.cache_write_tokens)],
                  ],
                  emptyText: "该时段暂无用量数据。",
                }}
              >
                {tokenHasData ? (
                  <canvas ref={tokenRef} />
                ) : (
                  <div className="flex h-full items-center justify-center text-[12.5px] text-faint">
                    该时段暂无用量数据。
                  </div>
                )}
              </ChartCard>
            </div>
            )}
          </>
        )
      )}

      {/* 缓存命中率 + 节省（全生命周期口径） */}
      <div className="border-t border-border px-5 py-4">
        <div className="flex items-center justify-between pb-1.5">
          <span className="text-[12.5px] text-muted">缓存命中率</span>
          <span className="text-[12.5px] font-medium tabular-nums text-fg">
            {hitPct != null ? `${hitPct}%` : "—"}
          </span>
        </div>
        <Progress value={hitPct ?? 0} aria-label="缓存命中率" />
        <div className="mt-3 flex items-center justify-between">
          <span className="text-[12.5px] text-muted">缓存为你节省</span>
          <span className="text-[13.5px] font-semibold text-success">
            {data.savings.savings_unavailable || data.savings.savings_credits == null
              ? "—"
              : `${formatCredits(data.savings.savings_credits)} 积分`}
            {data.savings.savings_is_estimate ? (
              <span className="ml-1 text-[11px] font-normal text-faint">（估算）</span>
            ) : null}
          </span>
        </div>
        {data.savings.savings_unavailable && (
          <p className="mt-1 text-[11.5px] text-faint">数据量较大，暂不展示节省精算值。</p>
        )}
        {/* 累计口径不回退：全生命周期请求 + 实际扣费 */}
        <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 border-t border-border pt-3 text-[12px]">
          <div className="flex items-center justify-between">
            <span className="text-muted">累计请求</span>
            <span className="tabular-nums text-fg">{groupDigits(s.requests_total)}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted">累计实际扣费</span>
            <span className="tabular-nums text-fg">{formatCredits(s.debited_credits)}</span>
          </div>
        </div>
      </div>

      {/* 会话维度明细 */}
      <div className="border-t border-border px-5 py-4">
        <div className="pb-2 text-[11px] font-medium uppercase tracking-wide text-faint">
          会话用量明细
        </div>
        {sessions.length === 0 ? (
          <p className="py-3 text-center text-[12.5px] text-faint">
            暂无会话维度用量{data.cutoff_started_at ? "" : "（功能上线后开始记录）"}。
          </p>
        ) : (
          <>
            <ul className="flex flex-col gap-0.5">
              {sessions.map((row) => {
                const tok = sumBig(row.input_tokens, row.output_tokens);
                // 组队(delegate)归组:后端只对含 delegate 行的会话下发 delegates
                // 明细;无组队数据时以下分支全部关闭,行渲染与旧版一致。
                const delegates = row.delegates ?? [];
                const hasDelegate = delegates.length > 0;
                const isOpen = hasDelegate && expandedDelegates.has(row.session_id);
                return (
                  <li key={row.session_id} className="rounded-lg px-2 py-2 hover:bg-hover">
                    <div className="flex items-center gap-3">
                      <span className="min-w-0 flex-1">
                        <span className="flex min-w-0 items-center gap-1.5">
                          <span className="truncate font-mono text-[12.5px] text-fg">
                            {row.session_id}
                          </span>
                          {row.delegate_only ? (
                            <span className="shrink-0 rounded-full bg-hover px-1.5 py-px text-[10.5px] text-muted">
                              组队
                            </span>
                          ) : null}
                        </span>
                        <span className="block truncate text-[11.5px] text-faint">
                          {groupDigits(row.requests)} 次 · {formatCompactCount(tok)} token ·{" "}
                          {shortTime(row.last_used_at)}
                        </span>
                      </span>
                      <span className="shrink-0 text-[13px] font-medium tabular-nums text-fg">
                        {formatCredits(row.billed_credits)}
                      </span>
                    </div>
                    {hasDelegate && (
                      <button
                        type="button"
                        onClick={() => toggleDelegates(row.session_id)}
                        aria-expanded={isOpen}
                        className="mt-1 inline-flex items-center gap-1 rounded-full border border-border bg-surface px-2 py-0.5 text-[11px] text-muted outline-none hover:text-fg focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        含组队 {formatCredits(row.delegate_credits ?? "0")} 积分
                        <span
                          aria-hidden
                          className={cn("transition-transform", isOpen && "rotate-180")}
                        >
                          ▾
                        </span>
                      </button>
                    )}
                    {isOpen && (
                      <ul className="mt-1.5 flex flex-col gap-1 border-l-2 border-border pl-3">
                        {delegates.map((d, i) => (
                          <li
                            key={`${d.delegate_agent_id ?? "unknown"}:${d.model}:${i}`}
                            className="flex items-center gap-2 text-[11.5px]"
                          >
                            <span className="min-w-0 flex-1 truncate">
                              <span className="text-fg">
                                {agentDisplayName(d.delegate_agent_id) || "未知成员"}
                              </span>
                              <span className="text-faint">
                                {" "}
                                · {d.model} · {groupDigits(d.requests)} 次
                              </span>
                            </span>
                            <span className="shrink-0 tabular-nums text-muted">
                              {formatCredits(d.billed_credits)}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                );
              })}
            </ul>
            {hasMore && (
              <div className="pt-2 text-center">
                <button
                  onClick={loadMore}
                  disabled={loadingMore}
                  className="text-[13px] text-muted outline-none hover:text-fg focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
                >
                  {loadingMore ? "加载中…" : "加载更多"}
                </button>
              </div>
            )}
            {/[1-9]/.test(data.legacy_unattributed.requests) && (
              <p className="mt-2 text-[11.5px] text-faint">
                另有 {groupDigits(data.legacy_unattributed.requests)} 次早期请求未归属到具体会话。
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="rounded-xl border border-border bg-surface px-3 py-2.5">
      <div className="text-[11px] text-faint">{label}</div>
      <div
        className={cn(
          "mt-0.5 text-[16px] font-semibold tabular-nums",
          accent ? "text-accent" : "text-fg",
        )}
      >
        {value}
      </div>
    </div>
  );
}
