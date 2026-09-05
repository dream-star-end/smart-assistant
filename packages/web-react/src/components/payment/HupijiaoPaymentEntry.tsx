import { Copy, ExternalLink } from "lucide-react";
import { useEffect, useState } from "react";
import { reportClientFrictionOnce } from "../../lib/clientFriction";
import { savePendingPayment, type PendingPayment } from "../../lib/pendingPayment";
import { formatCentsYuan } from "../../lib/utils";
import { Alert, Button, Spinner, buttonVariants } from "../ui";

export type PaymentClientKind = "desktop" | "mobile" | "wechat";

type PaymentNavigator = Pick<Navigator, "maxTouchPoints" | "platform" | "userAgent"> & {
  userAgentData?: { mobile?: boolean };
};

const MOBILE_UA = /Android|iPhone|iPad|iPod|IEMobile|Mobile|Opera Mini|webOS/i;
const HUPIJIAO_HOST_ALLOW = /(^|\.)xunhupay\.com$|(^|\.)hupijiao\.com$|(^|\.)dpweixin\.com$/i;
const ORDER_NO_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

function safeHupijiaoMobileUrl(raw: string | null): string | null {
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (!HUPIJIAO_HOST_ALLOW.test(url.hostname)) return null;
  return url.toString();
}

/** 同步识别终端，仅用于给二维码配正确操作提示。 */
export function paymentClientKind(
  nav: PaymentNavigator | undefined = typeof navigator === "undefined"
    ? undefined
    : (navigator as PaymentNavigator),
): PaymentClientKind {
  if (!nav) return "desktop";
  // 微信 WebView 也是 mobile；必须先判微信，避免被 userAgentData.mobile 提前吃掉。
  if (/MicroMessenger/i.test(nav.userAgent)) return "wechat";
  if (nav.userAgentData?.mobile === true || MOBILE_UA.test(nav.userAgent)) return "mobile";
  // iPadOS 的 Safari 可能伪装成 Macintosh；限定 MacIntel + 多点触控，避免泛化触摸屏判断。
  if (nav.platform === "MacIntel" && nav.maxTouchPoints > 1) return "mobile";
  return "desktop";
}

/** 当前订单恢复 URL（含 order_no），系统浏览器打开后 PendingPaymentRecovery 可续轮询。 */
export function paymentRecoveryUrl(
  orderNo: string,
  href: string = typeof window === "undefined" ? "https://localhost/" : window.location.href,
): string {
  const url = new URL(href);
  if (ORDER_NO_PATTERN.test(orderNo)) url.searchParams.set("order_no", orderNo);
  return url.toString();
}

export function remainingPaymentMs(expiresAt: string | undefined, now = Date.now()): number {
  if (!expiresAt) return 0;
  const t = new Date(expiresAt).getTime();
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, t - now);
}

export function formatPaymentCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** 虎皮椒支付入口：桌面挂 QR，普通手机挂 H5，微信 WebView 给复制链接。 */
export function HupijiaoPaymentEntry({
  qrcodeUrl,
  mobileUrl,
  pendingPayment,
  amountCents,
  expiresAt,
  onReorder,
  token,
}: {
  qrcodeUrl: string;
  mobileUrl: string | null;
  pendingPayment: PendingPayment;
  amountCents?: string;
  expiresAt?: string;
  onReorder?: () => void;
  token?: string | null;
}) {
  const client = paymentClientKind();
  const [now, setNow] = useState(() => Date.now());
  const [copied, setCopied] = useState(false);
  const remaining = expiresAt ? remainingPaymentMs(expiresAt, now) : null;
  const expired = remaining === 0;

  useEffect(() => {
    if (!expiresAt) return;
    if (remainingPaymentMs(expiresAt) <= 0) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [expiresAt]);

  async function copyRecoveryLink() {
    savePendingPayment(pendingPayment);
    const url = paymentRecoveryUrl(pendingPayment.orderNo);
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  const meta = (
    <div className="flex w-full flex-col items-center gap-1 text-center" data-testid="payment-order-meta">
      {amountCents ? (
        <div className="text-[20px] font-semibold text-fg" data-testid="payment-order-amount">
          {formatCentsYuan(amountCents)}
        </div>
      ) : null}
      {remaining != null ? (
        <p className="text-meta text-faint" data-testid="payment-countdown">
          {expired
            ? "订单已过期，请重新下单"
            : `剩余有效时间 ${formatPaymentCountdown(remaining)} · 过期后请重新下单`}
        </p>
      ) : (
        <p className="text-meta text-faint">过期后请重新下单</p>
      )}
    </div>
  );

  const reorderBtn = (
    <Button
      variant="primary"
      size="md"
      className="w-full"
      data-testid="payment-reorder"
      onClick={() => onReorder?.()}
    >
      重新下单
    </Button>
  );

  useEffect(() => {
    if (client !== "desktop" || !qrcodeUrl) return;
    reportClientFrictionOnce(
      `payment:qr_shown:${pendingPayment.orderNo}`,
      {
        surface: "payment",
        stage: "qr_shown",
        code: "QR_SHOWN",
        outcome: "succeeded",
        sessionId: pendingPayment.orderNo,
      },
      token,
    );
  }, [client, qrcodeUrl, pendingPayment.orderNo, token]);

  if (client === "wechat") {
    return (
      <div className="flex w-full flex-col items-center gap-2">
        {meta}
        <Alert tone="warning" className="w-full text-meta" data-testid="wechat-payment-browser-hint">
          当前支付通道不支持在微信内直接发起，请复制链接后在系统浏览器打开。
        </Alert>
        {expired ? (
          reorderBtn
        ) : (
          <>
            <Button
              variant="primary"
              size="md"
              className="w-full"
              data-testid="wechat-copy-payment-link"
              onClick={() => void copyRecoveryLink()}
            >
              <Copy size={16} /> {copied ? "已复制" : "复制链接"}
            </Button>
            <p className="text-center text-meta text-faint">
              在系统浏览器打开后自动恢复本次订单
            </p>
          </>
        )}
      </div>
    );
  }

  if (expired) {
    return (
      <div className="flex w-full flex-col items-center gap-2">
        {meta}
        {reorderBtn}
      </div>
    );
  }

  if (client === "mobile") {
    const href = safeHupijiaoMobileUrl(mobileUrl);
    if (!href) {
      return (
        <div className="flex w-full flex-col items-center gap-2">
          {meta}
          <Alert tone="warning" className="w-full text-meta" data-testid="mobile-payment-unavailable">
            当前订单无法在手机端发起，请改用电脑或另一台设备扫码支付。
          </Alert>
        </div>
      );
    }
    return (
      <div className="flex w-full flex-col items-center gap-2">
        {meta}
        <a
          href={href}
          className={buttonVariants({ variant: "primary", size: "md", className: "w-full" })}
          data-testid="mobile-payment-link"
          onClick={() => savePendingPayment(pendingPayment)}
        >
          <ExternalLink size={16} /> 前往微信支付
        </a>
        <p className="text-center text-meta text-faint">将跳转至微信支付，完成后返回本页自动确认。</p>
      </div>
    );
  }

  return (
    <>
      {meta}
      <div className="rounded-xl border border-border bg-white p-3">
        {/* url_qrcode 本身是 QR PNG，直接挂载；不要再次二维码化。 */}
        <img
          src={qrcodeUrl}
          alt="微信支付二维码"
          width={200}
          height={200}
          className="size-[200px] object-contain"
        />
      </div>
      <div className="flex items-center gap-1.5 text-meta text-faint">
        <Spinner size={13} /> 请用微信扫码支付，到账后自动确认…
      </div>
    </>
  );
}
