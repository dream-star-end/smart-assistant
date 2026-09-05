import { Check, CircleAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import type { AuthSession } from "../../lib/types";
import {
  clearPendingPayment,
  loadPendingPayment,
  savePendingPayment,
  type PendingPayment,
} from "../../lib/pendingPayment";
import { Button, Spinner } from "../ui";

const POLL_INTERVAL_MS = 3000;
const ORDER_NO_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

/** 从恢复 URL（?order_no=）解析 pending 单。 */
export function pendingPaymentFromUrl(
  href: string = typeof window === "undefined" ? "" : window.location.href,
): PendingPayment | null {
  if (!href) return null;
  try {
    const url = new URL(href);
    const orderNo = url.searchParams.get("order_no") ?? url.searchParams.get("orderNo");
    if (!orderNo || !ORDER_NO_PATTERN.test(orderNo)) return null;
    const label = url.searchParams.get("order_label");
    return {
      orderNo,
      label: label && label.trim() ? label : "微信支付",
    };
  } catch {
    return null;
  }
}

function stripOrderParamsFromUrl(): void {
  try {
    const url = new URL(window.location.href);
    if (!url.searchParams.has("order_no") && !url.searchParams.has("orderNo")) return;
    url.searchParams.delete("order_no");
    url.searchParams.delete("orderNo");
    url.searchParams.delete("order_label");
    window.history.replaceState(window.history.state, "", url.toString());
  } catch {
    /* ignore */
  }
}

type RecoveryResult =
  | { kind: "paid"; label: string }
  | { kind: "failed"; message: string }
  | null;

/** 手机跳出收银台再返回时的全局查单入口；不依赖原支付弹窗仍挂载。 */
export function PendingPaymentRecovery({
  auth,
  onPaid,
}: {
  auth: AuthSession;
  onPaid: () => void;
}) {
  const [pending, setPending] = useState<PendingPayment | null>(() => {
    const fromUrl = pendingPaymentFromUrl();
    if (fromUrl) {
      savePendingPayment(fromUrl);
      return fromUrl;
    }
    return loadPendingPayment();
  });
  const [result, setResult] = useState<RecoveryResult>(null);

  useEffect(() => {
    stripOrderParamsFromUrl();
  }, []);

  useEffect(() => {
    if (!pending) return;
    let cancelled = false;
    let timer: number | null = null;
    const tick = async () => {
      try {
        const order = await api.getOrder(auth, pending.orderNo);
        if (cancelled) return;
        if (order.status === "paid") {
          clearPendingPayment(pending.orderNo);
          setPending(null);
          setResult({ kind: "paid", label: pending.label });
          onPaid();
          window.dispatchEvent(new Event("openclaude:billing-paid"));
          return;
        }
        if (
          order.status === "expired" ||
          order.status === "canceled" ||
          order.status === "cancelled"
        ) {
          clearPendingPayment(pending.orderNo);
          setPending(null);
          setResult({ kind: "failed", message: "订单已失效，请重新发起支付。" });
          return;
        }
      } catch {
        // 返回瞬间网络可能尚未恢复；保留订单并继续轮询。
      }
      if (!cancelled) timer = window.setTimeout(tick, POLL_INTERVAL_MS);
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer != null) window.clearTimeout(timer);
    };
  }, [auth, onPaid, pending]);

  if (!pending && !result) return null;

  return (
    <div
      className="fixed inset-x-4 bottom-[calc(1rem+env(safe-area-inset-bottom))] z-[70] mx-auto flex max-w-md items-center gap-3 rounded-xl border border-border bg-elevated px-4 py-3 shadow-float"
      role="status"
      aria-live="polite"
      data-testid={pending ? "payment-recovery-pending" : `payment-recovery-${result?.kind}`}
    >
      {pending ? (
        <Spinner size={18} className="shrink-0" />
      ) : result?.kind === "paid" ? (
        <Check size={20} className="shrink-0 text-success" />
      ) : (
        <CircleAlert size={20} className="shrink-0 text-warning" />
      )}
      <div className="min-w-0 flex-1">
        <div className="text-section font-medium text-fg">
          {pending
            ? `正在确认${pending.label}结果…`
            : result?.kind === "paid"
              ? `${result.label}成功`
              : "支付未完成"}
        </div>
        <div className="mt-0.5 text-meta text-faint">
          {pending
            ? "到账后会自动更新，无需重复下单。"
            : result?.kind === "paid"
              ? "套餐与余额已更新。"
              : result?.message}
        </div>
      </div>
      {result && (
        <Button variant="ghost" size="sm" onClick={() => setResult(null)} className="shrink-0">
          知道了
        </Button>
      )}
    </div>
  );
}
