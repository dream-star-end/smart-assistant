import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { HupijiaoPaymentEntry } from "../src/components/payment/HupijiaoPaymentEntry";
import { PendingPaymentRecovery } from "../src/components/payment/PendingPaymentRecovery";
import { createMemoryAuthSession } from "../src/lib/authSession";

const auth = createMemoryAuthSession(() => {}, "browser-payment-token");

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <HupijiaoPaymentEntry
      qrcodeUrl="https://pay.test/mobile-should-not-load.png"
      mobileUrl="https://pay.xunhupay.com/wechat/browser-proof"
      pendingPayment={{ orderNo: "browser-order-1", label: "浏览器支付" }}
    />
    <PendingPaymentRecovery auth={auth} onPaid={() => {}} />
  </StrictMode>,
);
