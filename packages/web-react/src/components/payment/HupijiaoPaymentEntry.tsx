import { ExternalLink } from "lucide-react";
import { Alert, buttonVariants, Spinner } from "../ui";

export type PaymentClientKind = "desktop" | "mobile" | "wechat";

type PaymentNavigator = Pick<Navigator, "maxTouchPoints" | "platform" | "userAgent"> & {
  userAgentData?: { mobile?: boolean };
};

const MOBILE_UA = /Android|iPhone|iPad|iPod|IEMobile|Mobile|Opera Mini|webOS/i;

/**
 * 虎皮椒要求 PC 的 url_qrcode 与手机的 url 二选一，不能先加载二维码再跳手机链接。
 * 因此这里必须在首次 render 前同步分类，不能放进 effect，也不能靠响应式 CSS 隐藏图片。
 */
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

/**
 * 虎皮椒支付入口。桌面只挂载二维码图片；手机只挂载手机支付链接；微信 WebView 安全失败。
 * 互斥渲染是功能要求：仅用 CSS 隐藏仍会请求图片，从而提前占用二维码支付路径。
 */
export function HupijiaoPaymentEntry({
  qrcodeUrl,
  mobileUrl,
}: {
  qrcodeUrl: string;
  mobileUrl: string | null;
}) {
  const client = paymentClientKind();

  if (client === "wechat") {
    return (
      <Alert tone="warning" className="w-full text-[12.5px]" data-testid="wechat-payment-browser-hint">
        当前支付通道不支持在微信内直接发起。请点击右上角“···”，选择“在浏览器打开”，然后重新下单。
      </Alert>
    );
  }

  if (client === "mobile") {
    if (!mobileUrl) {
      return (
        <Alert tone="warning" className="w-full text-[12.5px]" data-testid="mobile-payment-unavailable">
          当前订单无法在手机端发起，请在电脑端打开本页后重新下单。
        </Alert>
      );
    }
    return (
      <div className="flex w-full flex-col items-center gap-2">
        <a
          href={mobileUrl}
          className={buttonVariants({ variant: "primary", size: "md", className: "w-full" })}
          data-testid="mobile-payment-link"
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
