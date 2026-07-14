import { Spinner } from "../ui";

export type PaymentClientKind = "desktop" | "mobile" | "wechat";

type PaymentNavigator = Pick<Navigator, "maxTouchPoints" | "platform" | "userAgent"> & {
  userAgentData?: { mobile?: boolean };
};

const MOBILE_UA = /Android|iPhone|iPad|iPod|IEMobile|Mobile|Opera Mini|webOS/i;

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

/**
 * 虎皮椒微信 App 唤醒已停用。所有终端只使用 url_qrcode：桌面直接扫码，手机截图后
 * 从微信“扫一扫”的相册选择截图。绝不渲染上游仍返回但当前不可用的 mobileUrl。
 */
export function HupijiaoPaymentEntry({ qrcodeUrl }: { qrcodeUrl: string }) {
  const client = paymentClientKind();

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
      {client === "desktop" ? (
        <div className="flex items-center gap-1.5 text-[12.5px] text-faint">
          <Spinner size={13} /> 请用微信扫码支付，到账后自动确认…
        </div>
      ) : (
        <div
          className="flex items-start gap-1.5 text-center text-[12.5px] leading-relaxed text-faint"
          data-testid={
            client === "wechat" ? "wechat-screenshot-payment-hint" : "mobile-screenshot-payment-hint"
          }
        >
          <Spinner size={13} className="mt-0.5 shrink-0" />
          <span>
            {client === "wechat"
              ? "请先截图保存二维码，关闭当前页，再打开微信“扫一扫”，从相册选择该截图支付。"
              : "请先截图保存二维码，再打开微信“扫一扫”，从相册选择该截图支付。"}
          </span>
        </div>
      )}
    </>
  );
}
