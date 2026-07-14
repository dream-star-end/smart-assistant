import { Check, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import type { AuthSession, OrgPayResult } from "../../lib/types";
import { formatCentsYuan } from "../../lib/utils";
import { HupijiaoPaymentEntry } from "../payment/HupijiaoPaymentEntry";
import { Alert, Button } from "../ui";

const POLL_INTERVAL_MS = 3000;
/** 轮询上限(防悬挂):超时停轮询,提示已支付则稍后核对。 */
const POLL_MAX_MS = 5 * 60 * 1000;

/**
 * 企业席位订单「扫码 + 到账」段(创建向导 / 订阅 / 加席共用,单一权威)。
 * 到账判定 = 轮询 GET /api/payment/orders/:order_no(api.getOrder),status→'paid' 即到账;
 * expired/canceled 停轮询提示。轮询在到账 / 超时 / 卸载(cleanup)时统一清定时器,无悬挂。
 *
 * `onPaid` 须稳定引用(调用方 useCallback),否则效果重启会重置轮询计时。
 */
export function OrgPayQr({
  auth,
  order,
  amountCents,
  note,
  onPaid,
  onBack,
  backLabel = "返回",
}: {
  auth: AuthSession;
  order: OrgPayResult;
  /** 应付金额(分,字符串大数);用于大字展示。 */
  amountCents: string;
  /** 订单用途文案(如「订阅 企业标准 · 5 席」)。 */
  note: string;
  /** 到账回调(须稳定)。 */
  onPaid: () => void;
  onBack?: () => void;
  backLabel?: string;
}) {
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const startedAt = Date.now();
    let cancelled = false;
    let inflight = false;
    let timer: number | null = null;
    const stop = () => {
      if (timer != null) {
        window.clearInterval(timer);
        timer = null;
      }
    };
    const tick = async () => {
      if (inflight || cancelled) return;
      if (Date.now() - startedAt > POLL_MAX_MS) {
        stop();
        if (!cancelled) setErr("等待超时,若已支付请稍后在组织中心查看到账。");
        return;
      }
      inflight = true;
      try {
        const o = await api.getOrder(auth, order.orderNo);
        if (cancelled) return;
        if (o.status === "paid") {
          stop();
          onPaid();
        } else if (o.status === "expired" || o.status === "canceled" || o.status === "cancelled") {
          stop();
          setErr("订单已失效,请返回重新发起。");
        }
      } catch {
        // 单次轮询失败不致命(网络抖动 / 端点暂不可用),下个 tick 继续。
      } finally {
        inflight = false;
      }
    };
    timer = window.setInterval(tick, POLL_INTERVAL_MS);
    void tick();
    return () => {
      cancelled = true;
      stop();
    };
  }, [auth, order.orderNo, onPaid]);

  return (
    <div className="flex flex-col items-center gap-3">
      {err && (
        <Alert tone="warning" className="w-full text-[12.5px]">
          {err}
        </Alert>
      )}
      <div className="text-center">
        <div className="text-[20px] font-semibold text-fg">{formatCentsYuan(amountCents)}</div>
        <div className="text-[12.5px] text-faint">{note}</div>
      </div>
      <HupijiaoPaymentEntry qrcodeUrl={order.qr} />
      {onBack && (
        <Button variant="ghost" size="sm" onClick={onBack} className="text-muted">
          <RefreshCw size={14} /> {backLabel}
        </Button>
      )}
    </div>
  );
}

/** 到账成功卡(向导 / 订阅 / 加席共用)。 */
export function OrgPaySuccess({
  title,
  subtitle,
  onDone,
  doneLabel = "完成",
}: {
  title: string;
  subtitle?: string;
  onDone: () => void;
  doneLabel?: string;
}) {
  return (
    <div className="flex flex-col items-center gap-3 py-4 text-center">
      <span className="flex size-12 items-center justify-center rounded-full bg-success-soft text-success">
        <Check size={26} />
      </span>
      <div className="text-[15px] font-semibold text-fg">{title}</div>
      {subtitle && <p className="text-[12.5px] text-faint">{subtitle}</p>}
      <Button variant="primary" size="sm" onClick={onDone} className="mt-1">
        {doneLabel}
      </Button>
    </div>
  );
}
