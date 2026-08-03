const PENDING_PAYMENT_KEY = "openclaude_pending_order";
const ORDER_NO_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

export type PendingPayment = {
  orderNo: string;
  label: string;
};

/**
 * 手机 H5 支付会离开当前 document；用 sessionStorage 保留最小订单身份，返回后继续查单。
 * key 沿用旧 Web 前端，避免 React 切换期间遗留订单失去恢复入口。
 */
export function savePendingPayment(payment: PendingPayment): boolean {
  if (!ORDER_NO_PATTERN.test(payment.orderNo)) return false;
  try {
    sessionStorage.setItem(
      PENDING_PAYMENT_KEY,
      JSON.stringify({ order_no: payment.orderNo, label: payment.label }),
    );
    return true;
  } catch {
    return false;
  }
}

export function loadPendingPayment(): PendingPayment | null {
  try {
    const raw = sessionStorage.getItem(PENDING_PAYMENT_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as { order_no?: unknown; label?: unknown };
    if (typeof value.order_no !== "string" || !ORDER_NO_PATTERN.test(value.order_no)) return null;
    return {
      orderNo: value.order_no,
      label: typeof value.label === "string" && value.label.trim() ? value.label : "微信支付",
    };
  } catch {
    return null;
  }
}

export function clearPendingPayment(orderNo: string): void {
  try {
    if (loadPendingPayment()?.orderNo === orderNo) sessionStorage.removeItem(PENDING_PAYMENT_KEY);
  } catch {
    // Safari 隐私模式可能拒绝 storage；支付结果本身不受影响。
  }
}
