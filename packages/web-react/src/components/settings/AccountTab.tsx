import { Building2, Crown, Plus, Wallet } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ChartCard, barConfig, chartNum, donutConfig, useChart } from "../charts";
import { api, apiErrorMessage } from "../../lib/api";
import type {
  AuthSession,
  MySubscription,
  UsageLedgerRow,
  UsageReport,
  UsageReportWindow,
  User,
} from "../../lib/types";
import { cn, formatCredits } from "../../lib/utils";
import { Alert, Button, Progress, Skeleton, Spinner, Tabs } from "../ui";
import { CreateOrgDialog } from "../org/CreateOrgWizard";
import { formatReportBucket, ledgerReasonLabel, REPORT_WINDOW_NOUN, shortTime } from "./labels";

/** 账单收支卡窗口（默认 30d，独立于用量 Tab 的窗口）。 */
const ACCT_WINDOWS: { value: UsageReportWindow; label: string }[] = [
  { value: "7d", label: "7 天" },
  { value: "30d", label: "30 天" },
];

/** 大数字符串 → BigInt（非整数/非法按 0，用于套餐进度精确计算）。 */
function bigOr0(s: string): bigint {
  try {
    return /^-?\d+$/.test(s) ? BigInt(s) : 0n;
  } catch {
    return 0n;
  }
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? "—"
    : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const LEDGER_PAGE = 20;

/**
 * 账户与计费 Tab：余额（credits 字符串大数）+ 充值入口 + 账单流水（credit_ledger，
 * id 游标 keyset 分页）。余额由 /api/me 权威，本面板只读展示；充值走 TopupDialog。
 */
export function AccountTab({
  auth,
  user,
  onManageSub,
  reloadKey,
  onRefreshMe,
}: {
  auth: AuthSession;
  user: User | null;
  /** 打开订阅中心（套餐 + 加量包）。 */
  onManageSub: () => void;
  /** 外部（订阅/加量包到账）变更时 +1，触发流水 + 订阅重拉。 */
  reloadKey: number;
  /** 组织创建到账后刷新 /api/me（org 字段出现）。 */
  onRefreshMe?: () => void;
}) {
  const [rows, setRows] = useState<UsageLedgerRow[]>([]);
  const [createOrgOpen, setCreateOrgOpen] = useState(false);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ledgerReloadTick, setLedgerReloadTick] = useState(0);
  const [sub, setSub] = useState<MySubscription | null>(null);

  // 积分收支卡（窗口口径，独立于用量 Tab）。
  const [acctWindow, setAcctWindow] = useState<UsageReportWindow>("30d");
  const [report, setReport] = useState<UsageReport | null>(null);
  const [reportLoading, setReportLoading] = useState(true);
  const [reportErr, setReportErr] = useState<string | null>(null);
  const [reportReloadTick, setReportReloadTick] = useState(0);

  // 当前订阅（含双钱包余额明细）；reloadKey 变更（到账）后重拉。
  useEffect(() => {
    let alive = true;
    api
      .getMySubscription(auth)
      .then((s) => {
        if (alive) setSub(s);
      })
      .catch(() => {
        /* 订阅读取失败：仅不显示套餐卡，不阻断账户页 */
      });
    return () => {
      alive = false;
    };
  }, [auth, reloadKey]);

  // 收支报表：窗口切换 / 到账（reloadKey）/ 重试即重拉。切窗口先清 report 显 Skeleton。
  useEffect(() => {
    let alive = true;
    setReportLoading(true);
    setReportErr(null);
    setReport(null);
    api
      .getMyUsageReport(auth, acctWindow)
      .then((r) => {
        if (alive) setReport(r);
      })
      .catch((e) => {
        if (alive) setReportErr(apiErrorMessage(e, "加载收支图表失败"));
      })
      .finally(() => {
        if (alive) setReportLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [auth, acctWindow, reloadKey, reportReloadTick]);

  const credits = user?.credits ?? null;
  const isZero = credits != null && /^-?0+$/.test(credits.trim());
  const isNegative = credits != null && credits.trim().startsWith("-");
  const low = isZero || isNegative;

  // 首屏 + reloadKey 变更：重拉第一页流水。
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setErr(null);
    api
      .getUsage(auth, { ledgerLimit: LEDGER_PAGE })
      .then((u) => {
        if (!alive) return;
        setRows(u.ledger.rows);
        setNextBefore(u.ledger.next_before);
      })
      .catch((e) => {
        if (alive) setErr(apiErrorMessage(e, "加载账单流水失败"));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [auth, reloadKey, ledgerReloadTick]);

  const loadMore = useCallback(async () => {
    if (!nextBefore || loadingMore) return;
    setLoadingMore(true);
    try {
      const u = await api.getUsage(auth, { ledgerLimit: LEDGER_PAGE, ledgerBefore: nextBefore });
      setRows((prev) => [...prev, ...u.ledger.rows]);
      setNextBefore(u.ledger.next_before);
    } catch (e) {
      setErr(apiErrorMessage(e, "加载更多失败"));
    } finally {
      setLoadingMore(false);
    }
  }, [auth, nextBefore, loadingMore]);

  const org = user?.org ?? null;
  const orgRoleLabel = org
    ? org.role === "owner"
      ? "拥有者"
      : org.role === "admin"
        ? "管理员"
        : "成员"
    : "";

  // 本期套餐进度（仅订阅有月度额度时显示）。已用 = 月度额度 − 期内剩余(balance.period)。
  const monthlyBig = sub ? bigOr0(sub.monthlyCredits) : 0n;
  const periodRemainBig = sub ? bigOr0(sub.balance.period) : 0n;
  const showQuota = monthlyBig > 0n;
  const usedPct = showQuota
    ? Math.min(100, Math.max(0, Number(((monthlyBig - periodRemainBig) * 10000n) / monthlyBig) / 100))
    : 0;

  // 收支图表数据（report 存在时才有值；null 时 canvas 不挂载，useChart 自 no-op）。
  const ledgerTrend = report?.ledger.trend ?? [];
  const byReason = report?.ledger.by_reason ?? [];
  const trendLabels = ledgerTrend.map((p) => formatReportBucket(p.bucket, acctWindow));
  const reasonHasData = byReason.some((r) => chartNum(r.debited) > 0);
  const trendHasData = ledgerTrend.some(
    (p) => chartNum(p.credited) > 0 || chartNum(p.debited) > 0,
  );

  const flowRef = useRef<HTMLCanvasElement>(null);
  const reasonRef = useRef<HTMLCanvasElement>(null);

  useChart(
    flowRef,
    (theme) =>
      barConfig(theme, {
        labels: trendLabels,
        series: [
          { label: "收入", data: ledgerTrend.map((p) => chartNum(p.credited)), colorToken: "success" },
          { label: "支出", data: ledgerTrend.map((p) => chartNum(p.debited)), colorToken: "danger" },
        ],
      }),
    [report, acctWindow],
  );
  useChart(
    reasonRef,
    (theme) =>
      donutConfig(theme, {
        labels: byReason.map((r) => ledgerReasonLabel(r.reason)),
        data: byReason.map((r) => chartNum(r.debited)),
        legend: "bottom",
      }),
    [report, acctWindow],
  );

  return (
    <div className="flex flex-col">
      {/* 我的组织(只读展示;管理功能在组织中心,仅 owner/admin 有入口) */}
      {org && (
        <div className="border-b border-border px-5 py-4">
          <div className="flex items-center gap-1.5 text-[12px] text-faint">
            <Building2 size={13} /> 我的组织
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <span className="text-[16px] font-semibold text-fg">{org.name}</span>
            <span className="rounded-full bg-hover px-2 py-0.5 text-[11px] font-medium text-muted">
              {orgRoleLabel}
            </span>
            {org.billing_delegate && (
              <span className="rounded-full bg-accent-soft px-2 py-0.5 text-[11px] font-medium text-accent">
                财务委派
              </span>
            )}
          </div>
          {org.status === "suspended" ? (
            <Alert tone="warning" className="mt-2 text-[12.5px]">
              该组织已被暂停,组织钱包与共享技能暂不可用。
            </Alert>
          ) : (
            <p className="mt-1 text-[12px] text-faint">
              {org.billing_enabled
                ? "你的对话用量可由组织钱包统一结算。"
                : "该组织未对你开启统一结算,用量按个人账户计费。"}
            </p>
          )}
        </div>
      )}

      {/* 无 org:自助开通入口(Claude/GPT 式)。 */}
      {!org && (
        <div className="border-b border-border px-5 py-4">
          <div className="flex items-center gap-1.5 text-[12px] text-faint">
            <Building2 size={13} /> 组织
          </div>
          <p className="mt-1 text-[13px] text-muted">
            创建组织，按席位订阅企业套餐，团队共享积分池、技能与统一发票。
          </p>
          <div className="mt-3">
            <Button variant="primary" size="sm" onClick={() => setCreateOrgOpen(true)}>
              <Building2 size={15} /> 创建组织
            </Button>
          </div>
        </div>
      )}

      {/* 当前套餐 */}
      <div className="border-b border-border px-5 py-4">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 text-[12px] text-faint">
              <Crown size={13} /> 当前套餐
            </div>
            <div className="mt-1 flex items-center gap-2">
              <span className="text-[18px] font-semibold text-fg">{sub?.planName ?? "—"}</span>
              {sub?.paid && (
                <span className="rounded-full bg-accent-soft px-2 py-0.5 text-[11px] font-medium text-accent">
                  到期 {fmtDate(sub.periodEnd)}
                </span>
              )}
            </div>
            <div className="mt-1 text-[12px] text-faint">
              每月 {sub ? formatCredits(sub.monthlyCredits) : "—"} 积分
              {sub ? ` · 本期剩余 ${formatCredits(sub.periodCredits)}` : ""}
            </div>
          </div>
          <Button variant="secondary" size="sm" onClick={onManageSub} className="shrink-0">
            {sub?.paid ? "续费 / 升档" : "升级套餐"}
          </Button>
        </div>
      </div>

      <div className="px-5 py-4">
        <div className="flex items-center gap-1.5 text-[12px] text-faint">
          <Wallet size={13} /> {user?.displayName || "账户"} · 总可用余额
        </div>
        <div
          className={cn(
            "mt-1 flex items-baseline gap-1.5 text-[28px] font-semibold tracking-tight tabular-nums",
            low ? "text-danger" : "text-fg",
          )}
        >
          {credits != null ? formatCredits(credits) : "—"}
          <span className="text-[14px] font-normal text-faint">积分</span>
        </div>
        {sub && (
          <div className="mt-1 text-[12px] text-faint">
            套餐期内 {formatCredits(sub.balance.period)} + 钱包 {formatCredits(sub.balance.wallet)}
          </div>
        )}
        {/* 本期套餐积分进度（仅订阅有月度额度时显示） */}
        {sub && showQuota && (
          <div className="mt-3">
            <div className="flex items-center justify-between pb-1.5 text-[12px]">
              <span className="text-muted">本期套餐积分</span>
              <span className="tabular-nums text-fg">
                本期剩余 {formatCredits(sub.balance.period)} / {formatCredits(sub.monthlyCredits)}
              </span>
            </div>
            <Progress value={usedPct} aria-label="本期套餐积分已用" />
          </div>
        )}
        {low && (
          <Alert tone="danger" className="mt-2 text-[12.5px]">
            余额不足，已暂停对话计费。充值或升级套餐后即可继续。
          </Alert>
        )}
        <div className="mt-3 flex flex-wrap gap-2">
          <Button variant="primary" size="sm" onClick={onManageSub}>
            <Crown size={15} /> 套餐订阅
          </Button>
          <Button variant="secondary" size="sm" onClick={onManageSub}>
            <Plus size={15} /> 加量包
          </Button>
        </div>
        <p className="mt-2 text-[12px] text-faint">
          按实际用量计量扣费，扣费优先消耗套餐期内积分。加量包仅在当前套餐有效期内可用；
          存量钱包余额永久有效、扣完期内桶后继续使用。
        </p>
      </div>

      {/* 积分收支（窗口口径图表，独立于用量 Tab） */}
      <div className="border-t border-border px-5 py-4">
        <div className="flex items-center justify-between gap-3 pb-3">
          <div className="text-[11px] font-medium uppercase tracking-wide text-faint">
            积分收支 · 近 {REPORT_WINDOW_NOUN[acctWindow]}
          </div>
          <div className="overflow-x-auto">
            <Tabs
              aria-label="收支统计窗口"
              value={acctWindow}
              onValueChange={(v) => setAcctWindow(v as UsageReportWindow)}
              items={ACCT_WINDOWS}
            />
          </div>
        </div>
        {reportLoading ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Skeleton className="h-[200px] rounded-xl" />
            <Skeleton className="h-[200px] rounded-xl" />
          </div>
        ) : reportErr ? (
          <>
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
          </>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <ChartCard title="收支趋势" hint="收入 / 支出" height={200}>
              {trendHasData ? (
                <canvas ref={flowRef} />
              ) : (
                <div className="flex h-full items-center justify-center text-[12.5px] text-faint">
                  该时段暂无收支记录。
                </div>
              )}
            </ChartCard>
            <ChartCard title="支出构成" hint="按类型" height={200}>
              {reasonHasData ? (
                <canvas ref={reasonRef} />
              ) : (
                <div className="flex h-full items-center justify-center text-[12.5px] text-faint">
                  该时段暂无支出。
                </div>
              )}
            </ChartCard>
          </div>
        )}
      </div>

      <div className="border-t border-border px-5 py-3">
        <div className="pb-2 text-[11px] font-medium uppercase tracking-wide text-faint">
          账单流水
        </div>
        {err && (
          <div className="mb-2">
            <Alert tone="danger" className="text-[12.5px]">
              {err}
            </Alert>
            <Button
              size="sm"
              variant="secondary"
              className="mt-2"
              aria-label="重试账单流水"
              onClick={() => setLedgerReloadTick((tick) => tick + 1)}
            >
              重试
            </Button>
          </div>
        )}
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-8 text-[13px] text-faint">
            <Spinner /> 加载中…
          </div>
        ) : err && rows.length === 0 ? null : rows.length === 0 ? (
          <p className="py-6 text-center text-[13px] text-faint">暂无账单记录</p>
        ) : (
          <>
            <ul className="flex flex-col gap-0.5">
              {rows.map((r) => {
                const neg = r.delta.trim().startsWith("-");
                return (
                  <li
                    key={r.id}
                    className="flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-hover"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13.5px] text-fg">
                        {ledgerReasonLabel(r.reason)}
                        {r.memo ? <span className="text-faint"> · {r.memo}</span> : null}
                      </span>
                      <span className="block truncate text-[11.5px] text-faint">
                        {shortTime(r.created_at)} · 余 {formatCredits(r.balance_after)}
                      </span>
                    </span>
                    <span
                      className={cn(
                        "shrink-0 text-[13.5px] font-medium tabular-nums",
                        neg ? "text-fg" : "text-success",
                      )}
                    >
                      {neg ? "" : "+"}
                      {formatCredits(r.delta)}
                    </span>
                  </li>
                );
              })}
            </ul>
            {nextBefore && (
              <div className="pt-2 text-center">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={loadMore}
                  disabled={loadingMore}
                  className="text-muted"
                >
                  {loadingMore ? "加载中…" : "加载更多"}
                </Button>
              </div>
            )}
          </>
        )}
      </div>

      <CreateOrgDialog
        open={createOrgOpen}
        auth={auth}
        onClose={() => setCreateOrgOpen(false)}
        onCreated={() => {
          setCreateOrgOpen(false);
          onRefreshMe?.();
        }}
      />
    </div>
  );
}
