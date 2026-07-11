import { useEffect, useRef, useState } from "react";
import { ChartCard, chartNum, lineConfig, useChart } from "../charts";
import { api } from "../../lib/api";
import type {
  AuthSession,
  OrgUsageReport,
  OrgUsageTotals,
  OrgUsageTrendPoint,
  OrgUsageWindow,
} from "../../lib/types";
import { cn, formatCompactCount, formatCredits, groupDigits, ratioPct } from "../../lib/utils";
import { Alert, Spinner, Tabs } from "../ui";
import { orgErrText } from "./orgShared";

const WINDOWS: { value: OrgUsageWindow; label: string }[] = [
  { value: "24h", label: "24 小时" },
  { value: "7d", label: "7 天" },
  { value: "30d", label: "30 天" },
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

/** 输入+输出 token（表格紧凑列，与个人版会话口径一致）。 */
function tokIO(t: OrgUsageTotals): string {
  return sumBig(t.input_tokens, t.output_tokens);
}

/**
 * 按扣费降序排序（BigInt 精确，非法项按 0）。导出供单测覆盖大数排序稳定性。
 */
export function sortByCreditsDesc<T extends { credits: string }>(rows: readonly T[]): T[] {
  const big = (s: string) => {
    try {
      return BigInt(/^-?\d+$/.test(s) ? s : "0");
    } catch {
      return 0n;
    }
  };
  return [...rows].sort((a, b) => {
    const av = big(a.credits);
    const bv = big(b.credits);
    return av > bv ? -1 : av < bv ? 1 : 0;
  });
}

/** 趋势序列某字段的最大值（BigInt，字符串大数）。导出供单测。 */
export function trendMax(
  trend: readonly OrgUsageTrendPoint[],
  key: "credits" | "requests",
): string {
  let max = 0n;
  for (const p of trend) {
    const v = p[key];
    if (/^-?\d+$/.test(v)) {
      try {
        const b = BigInt(v);
        if (b > max) max = b;
      } catch {
        /* skip */
      }
    }
  }
  return max.toString();
}

/** bucket 时间戳 → 紧凑轴标签。24h 用「HH:00」，其余用「M/D」。非法原样。 */
function fmtBucket(bucket: string, window: OrgUsageWindow): string {
  const d = new Date(bucket);
  if (Number.isNaN(d.getTime())) return bucket;
  if (window === "24h") return `${String(d.getHours()).padStart(2, "0")}:00`;
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

const TOKEN_PARTS: { key: keyof OrgUsageTotals; label: string; color: string }[] = [
  { key: "input_tokens", label: "输入", color: "bg-accent" },
  { key: "output_tokens", label: "输出", color: "bg-info" },
  { key: "cache_read_tokens", label: "缓存命中", color: "bg-success" },
  { key: "cache_write_tokens", label: "缓存写入", color: "bg-warning" },
];

/**
 * 报表：窗口切换（24h/7d/30d）→ GET /api/org/usage。summary Stat 卡 + token 堆叠条 +
 * 按成员表（扣费降序）+ 按模型表 + 趋势竖条。数据走批次 D（本文件权威，正常工作）。
 * 大数全程字符串（formatCompactCount / formatCredits / groupDigits / ratioPct）。
 */
export function ReportsTab({ auth }: { auth: AuthSession }) {
  const [window, setWindow] = useState<OrgUsageWindow>("24h");
  const [data, setData] = useState<OrgUsageReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  // 窗口切换即重拉。依赖数组含 window，**绝不含 loading**（防转圈）。切窗口先清 data 显 spinner。
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setErr(null);
    setData(null);
    api
      .getOrgUsage(auth, window)
      .then((d) => {
        if (alive) setData(d);
      })
      .catch((e) => {
        if (alive) setErr(orgErrText(e, "加载组织报表失败"));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [auth, window]);

  const s = data?.summary;
  const tokenTotal = s
    ? sumBig(s.input_tokens, s.output_tokens, s.cache_read_tokens, s.cache_write_tokens)
    : "0";
  const members = data ? sortByCreditsDesc(data.members) : [];
  const models = data ? sortByCreditsDesc(data.models) : [];
  const trend = data?.trend ?? [];
  const trendMetric: "credits" | "requests" =
    trendMax(trend, "credits") !== "0" ? "credits" : "requests";
  const trendPeak = trendMax(trend, trendMetric);
  const trendHasData = trend.length > 0 && trendPeak !== "0";

  // 趋势面积图（与个人版「积分消耗趋势」同视觉：单 series 折线填充）。
  const trendRef = useRef<HTMLCanvasElement>(null);
  useChart(
    trendRef,
    (theme) =>
      lineConfig(theme, {
        labels: trend.map((p) => fmtBucket(p.bucket, window)),
        series: [
          {
            label: trendMetric === "credits" ? "扣费" : "请求",
            data: trend.map((p) => chartNum(p[trendMetric])),
            colorToken: "accent",
            fill: true,
          },
        ],
      }),
    // data 为稳定 state 引用（trend/trendMetric 均由 data 派生），避免每渲染重建。
    [data, window],
  );

  return (
    <div className="flex flex-col">
      <div className="px-5 pt-4">
        <div className="overflow-x-auto">
          <Tabs
            aria-label="统计窗口"
            value={window}
            onValueChange={(v) => setWindow(v as OrgUsageWindow)}
            items={WINDOWS}
          />
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center gap-2 py-16 text-[13px] text-faint">
          <Spinner /> 加载报表…
        </div>
      ) : err ? (
        <div className="px-5 py-4">
          <Alert tone="danger" className="text-[12.5px]">
            {err}
          </Alert>
        </div>
      ) : !s ? null : (
        <>
          {/* 摘要卡片 */}
          <div className="grid grid-cols-2 gap-2 px-5 py-4">
            <Stat label="总请求数" value={groupDigits(s.requests)} />
            <Stat label="扣费" value={`${formatCredits(s.credits)} 积分`} accent />
            <Stat label="输入 token" value={formatCompactCount(s.input_tokens)} />
            <Stat label="输出 token" value={formatCompactCount(s.output_tokens)} />
          </div>

          {/* token 构成堆叠条 */}
          <div className="border-t border-border px-5 py-4">
            <div className="pb-2 text-[11px] font-medium uppercase tracking-wide text-faint">
              Token 构成
            </div>
            {tokenTotal === "0" ? (
              <p className="py-2 text-[12.5px] text-faint">该时段暂无用量数据。</p>
            ) : (
              <>
                <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-hover">
                  {TOKEN_PARTS.map((p) => {
                    const pct = ratioPct(s[p.key], tokenTotal);
                    if (pct <= 0) return null;
                    return (
                      <div
                        key={p.key}
                        className={p.color}
                        style={{ width: `${pct}%` }}
                        title={`${p.label} ${formatCompactCount(s[p.key])}`}
                      />
                    );
                  })}
                </div>
                <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1">
                  {TOKEN_PARTS.map((p) => (
                    <div key={p.key} className="flex items-center gap-1.5 text-[12px]">
                      <span className={cn("size-2 rounded-full", p.color)} />
                      <span className="text-muted">{p.label}</span>
                      <span className="ml-auto tabular-nums text-fg">
                        {formatCompactCount(s[p.key])}
                      </span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>

          {/* 趋势面积图（共享 charts，替代原手写 CSS 竖条） */}
          <div className="border-t border-border px-5 py-4">
            <ChartCard
              title={`趋势 · 按${trendMetric === "credits" ? "扣费" : "请求"}`}
              hint={`近 ${WINDOWS.find((w) => w.value === window)?.label ?? window}`}
              height={200}
            >
              {trendHasData ? (
                <canvas ref={trendRef} />
              ) : (
                <div className="flex h-full items-center justify-center text-[12.5px] text-faint">
                  该时段暂无趋势数据。
                </div>
              )}
            </ChartCard>
          </div>

          {/* 按成员 */}
          <UsageTable
            title="按成员"
            emptyText="该时段暂无成员用量。"
            rows={members.map((m) => ({
              key: m.user_id,
              name: m.display_name || m.email,
              sub: m.display_name ? m.email : undefined,
              requests: m.requests,
              tokens: tokIO(m),
              credits: m.credits,
            }))}
          />

          {/* 按模型 */}
          <UsageTable
            title="按模型"
            emptyText="该时段暂无模型用量。"
            rows={models.map((m) => ({
              key: m.model,
              name: m.model,
              requests: m.requests,
              tokens: tokIO(m),
              credits: m.credits,
            }))}
          />
        </>
      )}
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

type UsageRow = {
  key: string;
  name: string;
  sub?: string;
  requests: string;
  tokens: string;
  credits: string;
};

function UsageTable({
  title,
  emptyText,
  rows,
}: {
  title: string;
  emptyText: string;
  rows: UsageRow[];
}) {
  return (
    <div className="border-t border-border px-5 py-4">
      <div className="pb-2 text-[11px] font-medium uppercase tracking-wide text-faint">{title}</div>
      {rows.length === 0 ? (
        <p className="py-2 text-[12.5px] text-faint">{emptyText}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[26rem] text-[12.5px]">
            <thead>
              <tr className="text-left text-[11px] text-faint">
                <th className="pb-1.5 font-medium">名称</th>
                <th className="pb-1.5 text-right font-medium">请求</th>
                <th className="pb-1.5 text-right font-medium">Token</th>
                <th className="pb-1.5 text-right font-medium">扣费</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key} className="border-t border-border/60">
                  <td className="max-w-[12rem] py-1.5 pr-2">
                    <span className="block truncate text-fg">{r.name}</span>
                    {r.sub && <span className="block truncate text-[11px] text-faint">{r.sub}</span>}
                  </td>
                  <td className="py-1.5 text-right tabular-nums text-muted">
                    {groupDigits(r.requests)}
                  </td>
                  <td className="py-1.5 text-right tabular-nums text-muted">
                    {formatCompactCount(r.tokens)}
                  </td>
                  <td className="py-1.5 text-right font-medium tabular-nums text-fg">
                    {formatCredits(r.credits)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
