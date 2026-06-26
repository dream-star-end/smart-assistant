import { Plus, Wallet } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api } from "../../lib/api";
import type { AuthSession, UsageLedgerRow, User } from "../../lib/types";
import { cn, formatCredits } from "../../lib/utils";
import { Alert, Button, Spinner } from "../ui";
import { ledgerReasonLabel, shortTime } from "./labels";

const LEDGER_PAGE = 20;

/**
 * 账户与计费 Tab：余额（credits 字符串大数）+ 充值入口 + 账单流水（credit_ledger，
 * id 游标 keyset 分页）。余额由 /api/me 权威，本面板只读展示；充值走 TopupDialog。
 */
export function AccountTab({
  auth,
  user,
  onTopup,
  reloadKey,
}: {
  auth: AuthSession;
  user: User | null;
  onTopup: () => void;
  /** 外部（充值到账）变更时 +1，触发流水重拉。 */
  reloadKey: number;
}) {
  const [rows, setRows] = useState<UsageLedgerRow[]>([]);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [err, setErr] = useState<string | null>(null);

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
        if (alive) setErr((e as Error).message || "加载账单流水失败");
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
      setErr((e as Error).message || "加载更多失败");
    } finally {
      setLoadingMore(false);
    }
  }, [auth, nextBefore, loadingMore]);

  return (
    <div className="flex flex-col">
      <div className="px-5 py-4">
        <div className="flex items-center gap-1.5 text-[12px] text-faint">
          <Wallet size={13} /> {user?.displayName || "账户"} · 当前余额
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
        {low && (
          <Alert tone="danger" className="mt-2 text-[12.5px]">
            余额不足，已暂停对话计费。充值后即可继续。
          </Alert>
        )}
        <Button variant="primary" size="sm" onClick={onTopup} className="mt-3">
          <Plus size={15} /> 充值积分
        </Button>
        <p className="mt-2 text-[12px] text-faint">
          按所选智能体的实际用量计量扣费。充值即时到账，余额永久有效。
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
    </div>
  );
}
