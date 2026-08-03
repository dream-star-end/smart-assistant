import { ExternalLink } from "lucide-react";
import { savePendingPayment, type PendingPayment } from "../../lib/pendingPayment";
import { Alert, Spinner, buttonVariants } from "../ui";

export type PaymentClientKind = "desktop" | "mobile" | "wechat";

type PaymentNavigator = Pick<Navigator, "maxTouchPoints" | "platform" | "userAgent"> & {
  userAgentData?: { mobile?: boolean };
};

const MOBILE_UA = /Android|iPhone|iPad|iPod|IEMobile|Mobile|Opera Mini|webOS/i;
const HUPIJIAO_HOST_ALLOW = /(^|\.)xunhupay\.com$|(^|\.)hupijiao\.com$|(^|\.)dpweixin\.com$/i;

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

/** 虎皮椒支付入口：桌面只挂 QR，普通手机只挂 H5 支付链接，微信 WebView 明确退出。 */
export function HupijiaoPaymentEntry({
  qrcodeUrl,
  mobileUrl,
  pendingPayment,
}: {
  qrcodeUrl: string;
  mobileUrl: string | null;
  pendingPayment: PendingPayment;
}) {
  const client = paymentClientKind();

  if (client === "wechat") {
    return (
      <Alert tone="warning" className="w-full text-[12.5px]" data-testid="wechat-payment-browser-hint">
        当前支付通道不支持在微信内直接发起，请在系统浏览器打开本页后重新下单。
      </Alert>
    );
  }

  if (client === "mobile") {
    const href = safeHupijiaoMobileUrl(mobileUrl);
    if (!href) {
      return (
        <Alert tone="warning" className="w-full text-[12.5px]" data-testid="mobile-payment-unavailable">
          当前订单无法在手机端发起，请改用电脑或另一台设备扫码支付。
        </Alert>
      );
    }
    return (
      <div className="flex w-full flex-col items-center gap-2">
        <a
          href={href}
          className={buttonVariants({ variant: "primary", size: "md", className: "w-full" })}
          data-testid="mobile-payment-link"
          onClick={() => savePendingPayment(pendingPayment)}
        >
          <ExternalLink size={16} /> 前往微信支付
        </a>
        <p className="text-center text-[12px] text-faint">将跳转至微信支付，完成后返回本页自动确认。</p>
      </div>
    );
  }

  return (
    <>
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
      <div className="flex items-center gap-1.5 text-[12.5px] text-faint">
        <Spinner size={13} /> 请用微信扫码支付，到账后自动确认…
      </div>
    </>
  );
}
