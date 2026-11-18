import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiErrorMessage } from "../../lib/api";
import { type SiteAnalyticsData, sitesApi } from "../../lib/sitesApi";
import type { AuthSession } from "../../lib/types";
import { Alert, Button, SegmentedControl, Skeleton } from "../ui";

function formatShortDate(isoDate: string): string {
  const parts = isoDate.split("-");
  if (parts.length !== 3) return isoDate;
  return `${Number(parts[1])}月${Number(parts[2])}日`;
}

export function SiteAnalyticsTab({
  auth,
  slug,
}: {
  auth: AuthSession;
  slug: string;
}) {
  const [days, setDays] = useState<7 | 30>(30);
  const [data, setData] = useState<SiteAnalyticsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const slugRef = useRef(slug);
  slugRef.current = slug;
  const reqIdRef = useRef(0);

  useEffect(() => {
    setData(null);
    setErr(null);
    setHoverIdx(null);
  }, [slug]);

  const load = useCallback(
    async (winDays: 7 | 30) => {
      const reqSlug = slug;
      const reqId = ++reqIdRef.current;
      setLoading(true);
      setErr(null);
      try {
        const res = await sitesApi.getSiteAnalytics(auth, reqSlug, winDays);
        if (slugRef.current !== reqSlug || reqIdRef.current !== reqId) return;
        setData(res.analytics);
      } catch (e) {
        if (slugRef.current !== reqSlug || reqIdRef.current !== reqId) return;
        setErr(apiErrorMessage(e, "加载流量分析失败"));
      } finally {
        if (slugRef.current === reqSlug && reqIdRef.current === reqId) {
          setLoading(false);
        }
      }
    },
    [auth, slug],
  );

  useEffect(() => {
    void load(days);
  }, [load, days]);

  const chart = useMemo(() => {
    const series = data?.series ?? [];
    const maxRaw = series.reduce(
      (m, p) => Math.max(m, p.requests, p.pageViews, p.uniqueVisitors),
      0,
    );
    const niceMax = Math.max(4, Math.ceil(maxRaw * 1.15));
    const width = 680;
    const height = 220;
    const padL = 36;
    const padR = 16;
    const padT = 14;
    const padB = 26;
    const innerW = width - padL - padR;
    const innerH = height - padT - padB;
    const xAt = (i: number) =>
      series.length <= 1 ? padL + innerW / 2 : padL + (i / (series.length - 1)) * innerW;
    const yAt = (val: number) => padT + innerH - (val / niceMax) * innerH;
    const buildPath = (pick: (p: (typeof series)[number]) => number) =>
      series
        .map((p, i) => `${i === 0 ? "M" : "L"}${xAt(i).toFixed(1)},${yAt(pick(p)).toFixed(1)}`)
        .join(" ");

    const ticks = [0, Math.round(niceMax * 0.25), Math.round(niceMax * 0.5), Math.round(niceMax * 0.75), niceMax];
    const xLabelStep = series.length > 10 ? Math.max(1, Math.floor(series.length / 6)) : 1;

    return {
      series,
      width,
      height,
      padL,
      padR,
      padT,
      innerW,
      innerH,
      niceMax,
      ticks,
      xLabelStep,
      xAt,
      yAt,
      requestsPath: buildPath((p) => p.requests),
      pageViewsPath: buildPath((p) => p.pageViews),
      visitorsPath: buildPath((p) => p.uniqueVisitors),
    };
  }, [data]);

  const activePoint = hoverIdx !== null ? (chart.series[hoverIdx] ?? null) : null;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-wrap items-center gap-8 sm:gap-12">
          <div>
            <p className="text-meta text-muted">独立访客数</p>
            <p className="mt-1 text-2xl font-semibold tabular-nums text-fg">
              {loading && !data ? "—" : (data?.totals.uniqueVisitors ?? 0)}
            </p>
          </div>
          <div>
            <p className="text-meta text-muted">请求数</p>
            <p className="mt-1 text-2xl font-semibold tabular-nums text-fg">
              {loading && !data ? "—" : (data?.totals.requests ?? 0)}
            </p>
          </div>
          <div>
            <p className="text-meta text-muted">页面浏览量</p>
            <p className="mt-1 text-2xl font-semibold tabular-nums text-fg">
              {loading && !data ? "—" : (data?.totals.pageViews ?? 0)}
            </p>
          </div>
        </div>

        <SegmentedControl<string>
          aria-label="统计周期"
          size="sm"
          value={String(days)}
          onValueChange={(v) => setDays(v === "7" ? 7 : 30)}
          options={[
            { value: "7", label: "7 天" },
            { value: "30", label: "30 天" },
          ]}
        />
      </div>

      {err && (
        <Alert tone="danger">
          <div className="flex items-center justify-between gap-3">
            <span>{err}</span>
            <Button size="sm" variant="secondary" onClick={() => void load(days)}>
              重试
            </Button>
          </div>
        </Alert>
      )}

      <div className="rounded-xl border border-border bg-surface p-5">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-section font-semibold text-fg">流量趋势</h3>
            <p className="text-caption text-muted">每日</p>
          </div>
          <div className="flex flex-wrap items-center gap-4 text-caption text-muted">
            <span className="inline-flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-[#3b82f6]" />
              独立访客{activePoint ? ` ${activePoint.uniqueVisitors}` : ""}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-[#8b5cf6]" />
              请求数{activePoint ? ` ${activePoint.requests}` : ""}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-[#f97316]" />
              页面浏览量{activePoint ? ` ${activePoint.pageViews}` : ""}
            </span>
            {activePoint && (
              <span className="font-medium text-fg">{formatShortDate(activePoint.date)}</span>
            )}
          </div>
        </div>

        {loading && !data ? (
          <Skeleton className="h-56 w-full rounded-lg" />
        ) : (
          <svg
            viewBox={`0 0 ${chart.width} ${chart.height}`}
            className="h-56 w-full select-none"
            role="img"
            aria-label="站点每日流量趋势图"
            onMouseLeave={() => setHoverIdx(null)}
          >
            {chart.ticks.map((tick, idx) => {
              const y = chart.yAt(tick);
              return (
                <g key={`${idx}-${tick}`}>
                  <line
                    x1={chart.padL}
                    x2={chart.width - chart.padR}
                    y1={y}
                    y2={y}
                    stroke="currentColor"
                    strokeOpacity={0.1}
                    strokeDasharray={tick === 0 ? undefined : "3 3"}
                  />
                  <text
                    x={chart.padL - 8}
                    y={y + 3}
                    textAnchor="end"
                    fontSize="11"
                    className="fill-muted tabular-nums"
                  >
                    {tick}
                  </text>
                </g>
              );
            })}

            {chart.series.length > 0 && (
              <>
                <path
                  d={chart.requestsPath}
                  fill="none"
                  stroke="#8b5cf6"
                  strokeWidth={2}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
                <path
                  d={chart.pageViewsPath}
                  fill="none"
                  stroke="#f97316"
                  strokeWidth={2}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
                <path
                  d={chart.visitorsPath}
                  fill="none"
                  stroke="#3b82f6"
                  strokeWidth={2}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
              </>
            )}

            {chart.series.map((pt, i) => {
              const x = chart.xAt(i);
              const showLabel =
                i % chart.xLabelStep === 0 || i === chart.series.length - 1;
              return (
                <g key={pt.date}>
                  {showLabel && (
                    <text
                      x={x}
                      y={chart.height - 6}
                      textAnchor="middle"
                      fontSize="10.5"
                      className="fill-muted"
                    >
                      {formatShortDate(pt.date)}
                    </text>
                  )}
                  <rect
                    x={x - chart.innerW / Math.max(chart.series.length, 1) / 2}
                    y={chart.padT}
                    width={chart.innerW / Math.max(chart.series.length, 1)}
                    height={chart.innerH}
                    fill="transparent"
                    onMouseEnter={() => setHoverIdx(i)}
                  />
                </g>
              );
            })}
          </svg>
        )}
      </div>
    </div>
  );
}
