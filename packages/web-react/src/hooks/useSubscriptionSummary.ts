/**
 * 顶栏订阅入口轻量摘要 Hook（OCV5-844）。
 *
 * - 登录后静默拉取一次 `api.getMySubscription(auth)`，带同 auth 实例的 in-flight 去重；
 * - 404 / 未挂载商业计费 / 瞬时断网时静默回退 `null`，绝不阻断或污染首屏；
 * - 导出 `refresh()` 供支付/升级成功后立即刷新顶栏套餐徽标与详情。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { rememberSubscriptionPaid } from "../lib/subscribeIntent";
import type { AuthSession, MySubscription } from "../lib/types";

export interface SubscriptionSummary {
  paid: boolean;
  planName?: string | null;
  planCode?: string | null;
  periodEnd?: string | null;
  periodCredits?: number | null;
  status?: string | null;
}

const inFlightByAuth = new WeakMap<AuthSession, Promise<SubscriptionSummary | null>>();

function parsePeriodCredits(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function toSubscriptionSummary(sub: MySubscription): SubscriptionSummary {
  return {
    paid: Boolean(sub.paid),
    planName: sub.planName?.trim() || null,
    planCode: sub.planCode?.trim() || null,
    periodEnd: sub.periodEnd?.trim() || null,
    periodCredits: parsePeriodCredits(sub.periodCredits || sub.balance?.period),
    status: sub.status?.trim() || null,
  };
}

function fetchSubscriptionSummary(
  auth: AuthSession,
  force: boolean,
): Promise<SubscriptionSummary | null> {
  if (!force) {
    const existing = inFlightByAuth.get(auth);
    if (existing) return existing;
  }

  const req = api
    .getMySubscription(auth)
    .then((sub) => {
      const summary = toSubscriptionSummary(sub);
      rememberSubscriptionPaid(summary.paid);
      return summary;
    })
    .catch(() => null);

  inFlightByAuth.set(auth, req);
  void req.finally(() => {
    if (inFlightByAuth.get(auth) === req) {
      inFlightByAuth.delete(auth);
    }
  });
  return req;
}

export function useSubscriptionSummary(auth: AuthSession | null): {
  summary: SubscriptionSummary | null;
  refresh: () => void;
} {
  const [summary, setSummary] = useState<SubscriptionSummary | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  const forceNextRef = useRef(false);
  const reqSeqRef = useRef(0);

  const refresh = useCallback(() => {
    forceNextRef.current = true;
    setReloadTick((t) => t + 1);
  }, []);

  useEffect(() => {
    void reloadTick;
    if (!auth) {
      forceNextRef.current = false;
      setSummary(null);
      return;
    }

    const force = forceNextRef.current;
    forceNextRef.current = false;
    const mySeq = ++reqSeqRef.current;
    let alive = true;

    void fetchSubscriptionSummary(auth, force).then((next) => {
      if (!alive || reqSeqRef.current !== mySeq) return;
      setSummary(next);
    });

    return () => {
      alive = false;
    };
  }, [auth, reloadTick]);

  return { summary, refresh };
}
