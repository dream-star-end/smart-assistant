import { Building2, Crown, Plus, Wallet } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api, apiErrorMessage } from "../../lib/api";
import type { AuthSession, MySubscription, UsageLedgerRow, User } from "../../lib/types";
import { cn, formatCredits } from "../../lib/utils";
import { Alert, Button, Spinner } from "../ui";
import { CreateOrgDialog } from "../org/CreateOrgWizard";
import { ledgerReasonLabel, shortTime } from "./labels";

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
  const [sub, setSub] = useState<MySubscription | null>(null);

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
  }, [auth, reloadKey]);

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

      <div className="border-t border-border px-5 py-3">
        <div className="pb-2 text-[11px] font-medium uppercase tracking-wide text-faint">
          账单流水
        </div>
        {err && (
          <Alert tone="danger" className="mb-2 text-[12.5px]">
            {err}
          </Alert>
        )}
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-8 text-[13px] text-faint">
            <Spinner /> 加载中…
          </div>
        ) : rows.length === 0 ? (
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
