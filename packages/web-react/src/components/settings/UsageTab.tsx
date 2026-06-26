import { useCallback, useEffect, useState } from "react";
import { api } from "../../lib/api";
import type { AuthSession, UsageResponse, UsageSessionRow } from "../../lib/types";
import { cn, formatCompactCount, formatCredits, groupDigits, ratioPct } from "../../lib/utils";
import { Alert, Progress, Spinner } from "../ui";
import { shortTime } from "./labels";

const SESSIONS_PAGE = 20;

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

const TOKEN_PARTS: { key: keyof UsageResponse["summary"]; label: string; color: string }[] = [
  { key: "input_tokens", label: "输入", color: "bg-accent" },
  { key: "output_tokens", label: "输出", color: "bg-info" },
  { key: "cache_read_tokens", label: "缓存命中", color: "bg-success" },
  { key: "cache_write_tokens", label: "缓存写入", color: "bg-warning" },
];

/**
 * 用量统计 Tab：summary + token 构成（轻量 CSS 堆叠条，无图表依赖）+ 缓存命中率 +
 * 节省 + 会话维度明细（offset 分页）。所有大数字段全程字符串（formatCompactCount /
 * formatCredits / groupDigits / ratioPct，绝不 Number 化大数本身）。
 */
export function UsageTab({ auth }: { auth: AuthSession }) {
  const [data, setData] = useState<UsageResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [sessions, setSessions] = useState<UsageSessionRow[]>([]);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setErr(null);
    api
      .getUsage(auth, { sessionsLimit: SESSIONS_PAGE })
      .then((u) => {
        if (!alive) return;
        setData(u);
        setSessions(u.sessions.rows);
        setOffset(u.sessions.rows.length);
        setHasMore(u.sessions.has_more);
      })
      .catch((e) => {
        if (alive) setErr((e as Error).message || "加载用量统计失败");
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [auth]);

  const loadMore = useCallback(async () => {
    if (!hasMore || loadingMore) return;
    setLoadingMore(true);
    try {
      const u = await api.getUsage(auth, { sessionsLimit: SESSIONS_PAGE, sessionsOffset: offset });
      setSessions((prev) => [...prev, ...u.sessions.rows]);
      setOffset((o) => o + u.sessions.rows.length);
      setHasMore(u.sessions.has_more);
    } catch (e) {
      setErr((e as Error).message || "加载更多失败");
    } finally {
      setLoadingMore(false);
    }
  }, [auth, hasMore, loadingMore, offset]);

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
      </div>
    );
  }
  if (!data) return null;

  const s = data.summary;
  const tokenTotal = sumBig(
    s.input_tokens,
    s.output_tokens,
    s.cache_read_tokens,
    s.cache_write_tokens,
  );
  const hitPct = data.cache.hit_rate != null ? Math.round(data.cache.hit_rate * 1000) / 10 : null;

  return (
    <div className="flex flex-col">
      {/* 摘要卡片 */}
      <div className="grid grid-cols-2 gap-2 px-5 py-4">
        <Stat label="总请求数" value={groupDigits(s.requests_total)} />
        <Stat label="实际扣费" value={`${formatCredits(s.debited_credits)} 积分`} accent />
        <Stat label="输入 token" value={formatCompactCount(s.input_tokens)} />
        <Stat label="输出 token" value={formatCompactCount(s.output_tokens)} />
      </div>

      {/* token 构成堆叠条 */}
      <div className="border-t border-border px-5 py-4">
        <div className="pb-2 text-[11px] font-medium uppercase tracking-wide text-faint">
          Token 构成
        </div>
        {tokenTotal === "0" ? (
          <p className="py-2 text-[12.5px] text-faint">暂无用量数据。</p>
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

      {/* 缓存命中率 + 节省 */}
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
                return (
                  <li
                    key={row.session_id}
                    className="flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-hover"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-mono text-[12.5px] text-fg">
                        {row.session_id}
                      </span>
                      <span className="block truncate text-[11.5px] text-faint">
                        {groupDigits(row.requests)} 次 · {formatCompactCount(tok)} token ·{" "}
                        {shortTime(row.last_used_at)}
                      </span>
                    </span>
                    <span className="shrink-0 text-[13px] font-medium tabular-nums text-fg">
                      {formatCredits(row.billed_credits)}
                    </span>
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
